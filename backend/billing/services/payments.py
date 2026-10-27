"""Поступления от клиентов и статус оплаты счёта `[ТЗ 3.4.1]` (ADR-019).

Статус счёта выводится из суммы распределённых платежей и срока оплаты:

```
оплачено ≥ итог − 0.01                → paid
день срока прошёл, оплачено не всё    → overdue
оплачено > 0                          → partially_paid
иначе                                 → issued
```

Вывод выполняется при регистрации платежа и ежедневной проверкой сроков,
а не правкой статуса руками: статус, присвоенный в обход платежей,
разъехался бы с деньгами при первом же поступлении.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, ClassVar

from django.db import transaction
from django.db.models import Sum

from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from billing.models import Invoice, InvoiceStatus, Payment, PaymentAllocation, PaymentSource
from billing.services import fx
from core import clock
from core.exceptions import DomainError
from core.money import Money

if TYPE_CHECKING:
    from datetime import datetime

    from accounts.models import User
    from counterparties.models import Client

TOLERANCE = Decimal("0.01")

# Состояния счёта, к которым относится оплата: черновик ещё не выставлен,
# аннулированный выведен из обращения.
PAYABLE_STATUSES = (
    InvoiceStatus.ISSUED,
    InvoiceStatus.SENT,
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.OVERDUE,
)


class PaymentRejected(DomainError):
    """Платёж противоречит счетам: чужой счёт, переплата, несовпадение валют."""

    code = "VALIDATION_ERROR"
    http_status: ClassVar[int] = 400


@dataclass(frozen=True, slots=True)
class AllocationRequest:
    invoice: Invoice
    amount: Money


def paid_amount(invoice: Invoice) -> Decimal:
    """Сколько по счёту оплачено, в валюте счёта."""
    total = invoice.allocations.aggregate(total=Sum("amount"))["total"]
    return total or Decimal(0)


def derived_status(invoice: Invoice, *, paid: Decimal, at: datetime) -> str:
    """Статус оплаты счёта из платежей и срока."""
    if invoice.status not in (*PAYABLE_STATUSES, InvoiceStatus.PAID):
        return invoice.status
    total = invoice.total_amount
    if total > 0 and paid >= total - TOLERANCE:
        return InvoiceStatus.PAID
    # Просрочка — со следующего дня после срока: счёт со сроком «сегодня»
    # (постоплата без отсрочки) можно оплатить сегодня, и называть его
    # просроченным через минуту после выставления неверно.
    if invoice.due_date is not None and at.date() > invoice.due_date.date():
        return InvoiceStatus.OVERDUE
    if paid > 0:
        return InvoiceStatus.PARTIALLY_PAID
    # «Отправлен» сохраняется: выставленный счёт, ушедший клиенту, не
    # возвращается в «выставлен» оттого, что денег по нему ещё нет.
    return InvoiceStatus.SENT if invoice.status == InvoiceStatus.SENT else InvoiceStatus.ISSUED


def refresh_status(
    invoice: Invoice, *, actor: User | None = None, at: datetime | None = None
) -> bool:
    """Приводит статус счёта к выведенному. Возвращает, изменился ли он."""
    status = derived_status(invoice, paid=paid_amount(invoice), at=at or clock.now())
    if status == invoice.status:
        return False
    before = audit.snapshot(invoice, fields=["status"])
    invoice.status = status
    invoice.save(update_fields=["status", "updated_at", "version"])
    audit.record(
        entity_type=AuditEntityType.INVOICE,
        entity_id=invoice.pk,
        action="status_changed",
        actor=actor,
        before=before,
        after=audit.snapshot(invoice, fields=["status"]),
        source=AuditSource.USER if actor else AuditSource.SYSTEM,
        is_generated=invoice.is_generated,
    )
    return True


@transaction.atomic
def register(
    *,
    client: Client,
    amount: Money,
    received_at: datetime,
    allocations: list[AllocationRequest],
    source: str,
    external_id: str,
    comment: str,
    actor: User,
) -> Payment:
    """Регистрирует поступление и распределяет его по счетам."""
    if source not in PaymentSource.values:
        raise PaymentRejected(f"Неизвестный источник платежа: {source}")
    if external_id and Payment.objects.filter(source=source, external_id=external_id).exists():
        raise PaymentRejected(
            f"Платёж {external_id} из источника «{source}» уже зарегистрирован",
            {"externalId": external_id},
        )

    rates = fx.snapshot(received_at.date())["rates"]
    allocated_in_payment_currency = Money.zero(amount.currency)
    seen: set[str] = set()
    locked: list[tuple[Invoice, Money]] = []
    for item in allocations:
        invoice = Invoice.objects.select_for_update().get(pk=item.invoice.pk)
        if invoice.pk in seen:
            raise PaymentRejected(f"Счёт {invoice.number} указан в распределении дважды")
        seen.add(invoice.pk)
        if invoice.client_id != client.pk:
            raise PaymentRejected(
                f"Счёт {invoice.number or invoice.pk} выставлен другому клиенту",
                {"invoiceId": invoice.pk},
            )
        if invoice.status not in PAYABLE_STATUSES:
            raise PaymentRejected(
                f"Счёт {invoice.number or invoice.pk} не ожидает оплаты: "
                f"{invoice.get_status_display()}",
                {"invoiceId": invoice.pk},
            )
        if item.amount.currency != invoice.currency:
            raise PaymentRejected(
                f"Распределение по счёту {invoice.number} указывается в валюте счёта "
                f"{invoice.currency}",
                {"invoiceId": invoice.pk},
            )
        outstanding = invoice.total_amount - paid_amount(invoice)
        if item.amount.amount > outstanding + TOLERANCE:
            raise PaymentRejected(
                f"По счёту {invoice.number} осталось оплатить {outstanding:.2f} "
                f"{invoice.currency}, распределено больше",
                {"invoiceId": invoice.pk, "outstanding": f"{outstanding:.4f}"},
            )
        allocated_in_payment_currency = allocated_in_payment_currency + fx.convert(
            item.amount, amount.currency, rates
        )
        locked.append((invoice, item.amount))

    if allocated_in_payment_currency.amount > amount.amount + TOLERANCE:
        raise PaymentRejected(
            f"Распределено {allocated_in_payment_currency} при сумме платежа {amount}"
        )

    rate = rates.get(amount.currency)
    payment = Payment.objects.create(
        client=client,
        amount=amount.amount,
        currency=amount.currency,
        received_at=received_at,
        fx_rate=Decimal(str(rate)) if rate is not None else None,
        source=source,
        external_id=external_id,
        comment=comment,
        # Платёж клиента из набора генератора — тоже запись набора: иначе
        # очистка набора упёрлась бы в ссылку на его счёт (ADR-016, ADR-038).
        is_generated=client.is_generated,
    )
    for invoice, part in locked:
        PaymentAllocation.objects.create(
            payment=payment,
            invoice=invoice,
            amount=part.amount,
            currency=part.currency,
            is_generated=payment.is_generated,
        )

    audit.record(
        entity_type=AuditEntityType.PAYMENT,
        entity_id=payment.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(payment),
        comment=", ".join(f"{invoice.number}: {part}" for invoice, part in locked),
    )
    for invoice, _part in locked:
        refresh_status(invoice, actor=actor)
    return payment
