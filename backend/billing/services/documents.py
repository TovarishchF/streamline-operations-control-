"""Формирование котировок и счетов `[ТЗ 3.4.1]` (`SPEC.md § 7.2`).

Котировка строится из **планируемых** услуг рейса, счёт — из **фактически
оказанных**, по фактическому количеству и фактическому времени (ADR-020).
Это не одно и то же, и именно поэтому счёт отличается от котировки —
а сопоставление «план ↔ факт» объясняет, за счёт чего.

Округление (ADR-002) выполняется ровно в трёх точках: сумма строки,
сумма НДС строки, итоги документа. Итог считается суммой **уже округлённых**
строк, чтобы «итого» сходилось с колонкой на экране и в печатной форме.

Выставленный документ неизменяем (`BACKEND.md § 3.4`): правка — только
через аннулирование с выпуском нового.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType
from billing.models import (
    DocumentLine,
    Invoice,
    InvoiceStatus,
    Quote,
    QuoteStatus,
)
from billing.services import fx, numbering
from billing.services import tariffs as tariff_service
from catalog.models import VatApplicability, VatRate
from comms.services import events as comms_events
from core import clock
from core.exceptions import DocumentImmutable
from core.money import Money, money_sum
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from accounts.models import User
    from flights.models import Flight

# Заявки, попадающие в котировку: всё, кроме отменённых и отклонённых.
# Черновик включается намеренно — котировка показывает план, а услуга
# в плане есть, даже если поставщик ещё не выбран.
QUOTE_STATUSES = (
    ServiceOrderStatus.DRAFT,
    ServiceOrderStatus.ORDERED,
    ServiceOrderStatus.CONFIRMED,
    ServiceOrderStatus.IN_PROGRESS,
    ServiceOrderStatus.COMPLETED,
)

# В счёт идёт только выполненное: выставлять за услугу, которую не оказали,
# нельзя (`SPEC.md § 7.2`).
INVOICE_STATUSES = (ServiceOrderStatus.COMPLETED,)


class NothingToBill(DocumentImmutable):
    """Нечего включать в документ."""

    code = "VALIDATION_ERROR"


def _vat_rate_for(flight: Flight) -> VatRate | None:
    """Ставка НДС по признаку применимости `[ТЗ 3.4.1]`.

    Юридическая корректность применения подтверждается бухгалтером
    заказчика (`GAPS.md` G-07): система реализует справочник и применение,
    но не налоговую экспертизу.
    """
    applicability = (
        VatApplicability.INTERNATIONAL if flight.is_international else VatApplicability.DOMESTIC
    )
    return VatRate.objects.filter(applicability=applicability).order_by("-percent").first()


def _line_for(
    *,
    order: ServiceOrder,
    currency: str,
    rates: dict[str, Any],
    vat_rate: VatRate | None,
    client_id: str,
    moment: Any,
    use_actual: bool,
) -> dict[str, Any]:
    """Строка документа по заявке.

    `use_actual` различает котировку и счёт: в счёт идёт фактическое
    количество, в котировку — плановое. Для топлива они расходятся
    на каждом рейсе (ADR-020).
    """
    quantity = (
        order.actual_quantity
        if use_actual and order.actual_quantity is not None
        else order.quantity
    )

    price = tariff_service.sale_price(
        order=order,
        client_id=client_id,
        target_currency=currency,
        rates=rates,
        moment=moment,
    )

    amount = price.amount.rounded()
    unit = (
        Money(amount.amount / quantity, currency).rounded()
        if quantity
        else Money.zero(currency)
    )
    vat = amount.percent(vat_rate.percent).rounded() if vat_rate else Money.zero(currency)

    return {
        "service_order": order,
        "description": f"{order.service.name_ru} ({order.service.code})",
        "airport_icao": order.airport_icao,
        "quantity": quantity,
        "unit_price_amount": unit.amount,
        "amount": amount.amount,
        "currency": currency,
        "vat_rate": vat_rate,
        "vat_amount": vat.amount,
        "tariff_rule": price.rule,
    }


def _apply_totals(document: Quote | Invoice, lines: list[dict[str, Any]]) -> None:
    """Итоги — сумма уже округлённых строк (ADR-002 п. 3)."""
    currency = document.currency
    subtotal = money_sum([Money.of(line["amount"], currency) for line in lines], currency)
    vat = money_sum([Money.of(line["vat_amount"], currency) for line in lines], currency)

    document.subtotal_amount = subtotal.rounded().amount
    document.vat_amount = vat.rounded().amount
    document.discount_amount = Decimal(0)
    document.fees_amount = Decimal(0)
    document.total_amount = (subtotal + vat).rounded().amount


@transaction.atomic
def build_quote(
    *, flight: Flight, valid_until: Any | None, actor: User
) -> Quote:
    """Котировка из планируемых услуг рейса `[ТЗ 3.4.1]`."""
    orders = list(
        ServiceOrder.objects.filter(flight=flight, status__in=QUOTE_STATUSES)
        .select_related("service")
        .order_by("leg", "created_at")
    )
    if not orders:
        raise NothingToBill(
            _("По рейсу нет ни одной заявки на услугу — котировать нечего."),
            {"flightId": flight.pk},
        )

    snapshot = fx.snapshot(clock.now().date())
    currency = flight.billing_currency
    vat_rate = _vat_rate_for(flight)

    quote = Quote.objects.create(
        flight=flight,
        client=flight.client,
        currency=currency,
        fx_snapshot=snapshot,
        valid_until=valid_until,
        is_demo=flight.is_demo,
    )

    lines = [
        _line_for(
            order=order,
            currency=currency,
            rates=snapshot["rates"],
            vat_rate=vat_rate,
            client_id=flight.client_id,
            moment=flight.std_utc,
            use_actual=False,
        )
        for order in orders
    ]
    for line in lines:
        DocumentLine.objects.create(quote=quote, **line)

    _apply_totals(quote, lines)
    quote.save()

    audit.record(
        entity_type=AuditEntityType.QUOTE,
        entity_id=quote.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(quote),
        comment=_("Строк: %(count)d") % {"count": len(lines)},
        is_demo=quote.is_demo,
    )
    return quote


def _plan_fact(quote: Quote | None, lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Сопоставление «план ↔ факт» (`SPEC.md § 7.2`).

    Показывает, за счёт чего счёт отличается от котировки: изменилось
    количество, изменилась цена, позиция добавилась или выпала. Без
    этого расхождение приходится искать глазами по двум документам.
    """
    if quote is None:
        return []

    planned = {line.service_order_id: line for line in quote.lines.all()}
    comparison: list[dict[str, Any]] = []

    for line in lines:
        order = line["service_order"]
        plan = planned.pop(order.pk, None)
        if plan is None:
            comparison.append(
                {
                    "serviceOrderId": order.pk,
                    "kind": "added",
                    "planValue": None,
                    "factValue": {"amount": str(line["amount"]), "currency": line["currency"]},
                    "comment": _("Услуга не входила в котировку"),
                }
            )
            continue

        if plan.quantity != line["quantity"]:
            comparison.append(
                {
                    "serviceOrderId": order.pk,
                    "kind": "quantity_changed",
                    "planValue": {"amount": str(plan.amount), "currency": plan.currency},
                    "factValue": {"amount": str(line["amount"]), "currency": line["currency"]},
                    "comment": _("Количество: план %(plan)s, факт %(fact)s")
                    % {"plan": plan.quantity, "fact": line["quantity"]},
                }
            )
        elif plan.amount != line["amount"]:
            comparison.append(
                {
                    "serviceOrderId": order.pk,
                    "kind": "price_changed",
                    "planValue": {"amount": str(plan.amount), "currency": plan.currency},
                    "factValue": {"amount": str(line["amount"]), "currency": line["currency"]},
                    "comment": _("Сумма изменилась при том же количестве"),
                }
            )

    for order_id, plan in planned.items():
        comparison.append(
            {
                "serviceOrderId": order_id,
                "kind": "removed",
                "planValue": {"amount": str(plan.amount), "currency": plan.currency},
                "factValue": None,
                "comment": _("Услуга не была оказана"),
            }
        )

    return comparison


@transaction.atomic
def build_invoice(*, flight: Flight, quote: Quote | None, actor: User) -> Invoice:
    """Счёт по фактически оказанным услугам `[ТЗ 3.4.1]`.

    Строки строятся по фактическому количеству (ADR-020). Возвращает
    сопоставление «план ↔ факт» в поле документа.
    """
    orders = list(
        ServiceOrder.objects.filter(flight=flight, status__in=INVOICE_STATUSES)
        .select_related("service")
        .order_by("leg", "created_at")
    )
    if not orders:
        raise NothingToBill(
            _(
                "По рейсу нет ни одной выполненной услуги. Счёт выставляется "
                "за фактически оказанное — сначала завершите заявки."
            ),
            {"flightId": flight.pk},
        )

    snapshot = fx.snapshot(clock.now().date())
    currency = flight.billing_currency
    vat_rate = _vat_rate_for(flight)

    invoice = Invoice.objects.create(
        flight=flight,
        client=flight.client,
        quote=quote,
        currency=currency,
        fx_snapshot=snapshot,
        is_demo=flight.is_demo,
    )

    lines = [
        _line_for(
            order=order,
            currency=currency,
            rates=snapshot["rates"],
            vat_rate=vat_rate,
            client_id=flight.client_id,
            moment=order.actual_end_at or flight.std_utc,
            use_actual=True,
        )
        for order in orders
    ]
    for line in lines:
        DocumentLine.objects.create(invoice=invoice, **line)

    invoice.plan_fact_comparison = _plan_fact(quote, lines)
    _apply_totals(invoice, lines)
    invoice.save()

    audit.record(
        entity_type=AuditEntityType.INVOICE,
        entity_id=invoice.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(invoice),
        comment=_("Строк: %(count)d") % {"count": len(lines)},
        is_demo=invoice.is_demo,
    )
    return invoice


@transaction.atomic
def issue_quote(*, quote: Quote, actor: User) -> Quote:
    """Выставление котировки: присвоение номера и фиксация неизменяемости."""
    if quote.status != QuoteStatus.DRAFT:
        raise DocumentImmutable(
            _("Котировка уже выставлена и не может быть выставлена повторно"),
            {"status": quote.status},
        )

    before = audit.snapshot(quote)
    quote.number = numbering.next_number(numbering.QUOTE)
    quote.issued_at = clock.now()
    quote.status = QuoteStatus.ISSUED
    quote.save(update_fields=["number", "issued_at", "status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.QUOTE,
        entity_id=quote.pk,
        action="issued",
        actor=actor,
        before=before,
        after=audit.snapshot(quote),
        is_demo=quote.is_demo,
    )

    # Выставленный документ уходит клиенту письмом `[ТЗ 3.5.2]`.
    comms_events.document_issued(quote, kind="quote")
    return quote


@transaction.atomic
def issue_invoice(*, invoice: Invoice, actor: User) -> Invoice:
    """Выставление счёта: номер, дата и срок оплаты из условий клиента."""
    if invoice.status != InvoiceStatus.DRAFT:
        raise DocumentImmutable(
            _("Счёт уже выставлен и не может быть выставлен повторно"),
            {"status": invoice.status},
        )

    before = audit.snapshot(invoice)
    issued = clock.now()
    invoice.number = numbering.next_number(numbering.INVOICE, at=issued)
    invoice.issued_at = issued
    # Срок оплаты = дата выставления + отсрочка клиента (`DOMAIN.md § 6`)
    invoice.due_date = issued + timedelta(days=invoice.client.payment_defer_days)
    invoice.status = InvoiceStatus.ISSUED
    invoice.save(
        update_fields=["number", "issued_at", "due_date", "status", "updated_at", "version"]
    )

    audit.record(
        entity_type=AuditEntityType.INVOICE,
        entity_id=invoice.pk,
        action="issued",
        actor=actor,
        before=before,
        after=audit.snapshot(invoice),
        is_demo=invoice.is_demo,
    )

    comms_events.document_issued(invoice, kind="invoice")
    return invoice


@transaction.atomic
def void_invoice(*, invoice: Invoice, reason: str, actor: User) -> Invoice:
    """Аннулирование счёта `[ТЗ 3.4.1]`.

    Выставленный счёт не редактируется (`BACKEND.md § 3.4`): исправление —
    это аннулирование прежнего и выпуск нового со ссылкой на него. Строки
    аннулированного остаются: он был выставлен, и это факт истории.
    """
    if invoice.status == InvoiceStatus.VOIDED:
        raise DocumentImmutable(_("Счёт уже аннулирован"), {"status": invoice.status})
    if not reason.strip():
        raise DocumentImmutable(
            _("Аннулирование требует указания причины"), {"status": invoice.status}
        )

    before = audit.snapshot(invoice)
    invoice.status = InvoiceStatus.VOIDED
    invoice.save(update_fields=["status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.INVOICE,
        entity_id=invoice.pk,
        action="voided",
        actor=actor,
        before=before,
        after=audit.snapshot(invoice),
        comment=reason,
        is_demo=invoice.is_demo,
    )
    return invoice


@transaction.atomic
def void_quote(*, quote: Quote, reason: str, actor: User) -> Quote:
    if quote.status == QuoteStatus.VOIDED:
        raise DocumentImmutable(_("Котировка уже аннулирована"), {"status": quote.status})
    if not reason.strip():
        raise DocumentImmutable(
            _("Аннулирование требует указания причины"), {"status": quote.status}
        )

    before = audit.snapshot(quote)
    quote.status = QuoteStatus.VOIDED
    quote.save(update_fields=["status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.QUOTE,
        entity_id=quote.pk,
        action="voided",
        actor=actor,
        before=before,
        after=audit.snapshot(quote),
        comment=reason,
        is_demo=quote.is_demo,
    )
    return quote


@transaction.atomic
def respond_to_quote(*, quote: Quote, accepted: bool, actor: User) -> Quote:
    """Принятие или отклонение котировки клиентом `[ТЗ 3.5]`."""
    if quote.status != QuoteStatus.ISSUED:
        raise DocumentImmutable(
            _("Ответить можно только на выставленную котировку"), {"status": quote.status}
        )

    before = audit.snapshot(quote)
    quote.status = QuoteStatus.ACCEPTED if accepted else QuoteStatus.DECLINED
    quote.save(update_fields=["status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.QUOTE,
        entity_id=quote.pk,
        action="accepted" if accepted else "declined",
        actor=actor,
        before=before,
        after=audit.snapshot(quote),
        is_demo=quote.is_demo,
    )

    # Выставленный документ уходит клиенту письмом `[ТЗ 3.5.2]`.
    comms_events.document_issued(quote, kind="quote")
    return quote
