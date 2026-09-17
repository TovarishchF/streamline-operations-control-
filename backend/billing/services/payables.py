"""Заявки на оплату поставщикам `[ТЗ 3.4.2]` (`SPEC.md § 7.3`).

Заявка заводится автоматически при переходе услуги в «Выполнена»
(`DOMAIN.md § 5.2`): раньше этого момента нет ни факта оказания,
ни фактической стоимости, а позже — нет повода тянуть.

Срок оплаты считается от **снимка** условий контракта, зафиксированного
в заявке на услугу (ADR-025). Контракт мог смениться или кончиться,
а обязательство возникло на прежних условиях, и пересчитывать его
по сегодняшнему контракту значило бы переписывать историю
(`CLAUDE.md § 3` п. 5).
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType
from billing.models import Payable, PayableStatus
from billing.services import numbering
from core import clock
from core.exceptions import DomainError

if TYPE_CHECKING:
    from accounts.models import User
    from orders.models import ServiceOrder

# Отсрочка по умолчанию, если её нет ни в снимке условий, ни в контракте.
# Ноль означает «по факту»: платить сразу — безопаснее, чем придумать
# отсрочку, о которой с поставщиком не договаривались.
DEFAULT_DEFER_DAYS = 0


class PayableNotPending(DomainError):
    """Согласовать можно только заявку, ожидающую согласования."""

    code = "PAYABLE_NOT_PENDING"
    http_status = 409


def defer_days_for(order: ServiceOrder) -> int:
    """Отсрочка оплаты из снимка условий контракта (ADR-025)."""
    snapshot = order.contract_terms_snapshot or {}
    value = snapshot.get("paymentDeferDays")
    if value is None and order.contract is not None:
        value = order.contract.payment_defer_days
    try:
        return int(value) if value is not None else DEFAULT_DEFER_DAYS
    except (TypeError, ValueError):
        return DEFAULT_DEFER_DAYS


@transaction.atomic
def create_for_order(*, order: ServiceOrder, actor: User | None = None) -> Payable | None:
    """Заводит заявку на оплату по выполненной услуге.

    Возвращает `None`, когда платить некому или не за что: заявка без
    поставщика или с нулевой стоимостью — не повод заводить обязательство.

    Повторный вызов не создаёт вторую заявку: переход «Выполнена»
    может быть выполнен повторно из другого места, а обязательство
    возникает один раз.
    """
    if order.vendor_id is None:
        return None

    existing = Payable.objects.filter(service_orders=order).first()
    if existing is not None:
        return existing

    amount = order.purchase_cost_amount or Decimal(0)
    if amount <= 0:
        return None

    completed = order.completed_at or clock.now()
    payable = Payable.objects.create(
        number=numbering.next_number(numbering.PAYABLE, at=completed),
        vendor_id=order.vendor_id,
        amount=amount,
        currency=order.purchase_currency or "RUB",
        due_date=completed + timedelta(days=defer_days_for(order)),
        status=PayableStatus.PENDING,
        is_demo=order.is_demo,
    )
    payable.service_orders.add(order)

    audit.record(
        entity_type=AuditEntityType.PAYABLE,
        entity_id=payable.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(payable),
        comment=_("По выполненной заявке %(order)s") % {"order": order.pk},
        is_demo=payable.is_demo,
    )
    return payable


@transaction.atomic
def approve(*, payable: Payable, actor: User) -> Payable:
    """Согласование заявки на оплату `[ТЗ 3.4.2]`.

    Согласовывают то, что ещё не согласовано: повторное согласование
    ничего не меняет, а согласование оплаченной или спорной заявки
    скрыло бы её состояние.
    """
    if payable.status != PayableStatus.PENDING:
        raise PayableNotPending(
            _("Согласовать можно только заявку в ожидании согласования"),
            {"status": payable.status},
        )

    before = audit.snapshot(payable)
    payable.status = PayableStatus.APPROVED
    payable.approved_at = clock.now()
    payable.approved_by = actor
    payable.save()

    audit.record(
        entity_type=AuditEntityType.PAYABLE,
        entity_id=payable.pk,
        action="approved",
        actor=actor,
        before=before,
        after=audit.snapshot(payable),
        is_demo=payable.is_demo,
    )
    return payable


@transaction.atomic
def mark_disputed(*, payable: Payable, reason: str, actor: User | None = None) -> Payable:
    """Помечает заявку спорной по итогу сверки `[ТЗ 3.4.2]`.

    Спорная заявка не исчезает из реестра: расхождение с поставщиком
    решается перепиской, и обязательство всё это время существует.
    """
    before = audit.snapshot(payable)
    payable.status = PayableStatus.DISPUTED
    payable.save(update_fields=["status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.PAYABLE,
        entity_id=payable.pk,
        action="disputed",
        actor=actor,
        before=before,
        after=audit.snapshot(payable),
        comment=reason,
        is_demo=payable.is_demo,
    )
    return payable
