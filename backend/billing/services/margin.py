"""Маржа рейса `[ТЗ 3.4.3]` (`DOMAIN.md § 7.3`, ADR-012, ADR-023).

```
revenue   = Σ sale(заявки в расчёте) + Σ fees − Σ discounts
cost      = Σ cost(заявки в расчёте)
margin    = revenue − cost
marginPct = revenue = 0 ? null : margin / revenue × 100
```

Режимы: `plan` — все заявки, кроме отменённых и отклонённых; `fact` —
только выполненные; `mixed` — выполненные по факту, остальные по плану,
с долей плановой выручки. Отрицательная маржа отображается, а не
обнуляется.

Откуда суммы:
* план — снимок цены продажи при назначении поставщика (ADR-022) и
  закупка по снимку цены на плановое количество;
* факт — строка выставленного счёта, а пока счёта нет — продажа,
  зафиксированная при выполнении; закупка по фактическому количеству
  (ADR-020). Сборы и скидки уровня документа идут из счёта (ADR-023):
  тарифная скидка уже внутри цены продажи строки.

Заявка без цены поставщика (черновик без назначения) в расчёт не входит:
у неё нет ни закупки, ни продажи, и любой ноль на её месте был бы выдумкой.

Все суммы приводятся к валюте рейса по снимку курсов рейса (`SPEC.md § 7.4`).
Это каноничный путь ADR-012 — чистая функция на `Decimal`; агрегатный путь
для дашбордов сверяется с ним тестом.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Any

from django.core.cache import cache
from django.db import transaction

from billing.models import DocumentLine, Invoice, InvoiceStatus
from billing.services import fx
from core import clock
from core.exceptions import DomainError
from core.models import Settings
from core.money import Money
from orders.models import ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from flights.models import Flight
    from orders.models import ServiceOrder

logger = logging.getLogger(__name__)

MODES = ("plan", "fact", "mixed")
EXCLUDED = (ServiceOrderStatus.CANCELLED, ServiceOrderStatus.REJECTED)
# Счета, суммы которых — факт: выставленные и не аннулированные.
BILLED = (
    InvoiceStatus.ISSUED,
    InvoiceStatus.SENT,
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
)
PERCENT_QUANT = Decimal("0.01")
CACHE_TTL_SECONDS = 600


@dataclass(frozen=True, slots=True)
class Contribution:
    """Вклад одной заявки: плановые и фактические продажа и закупка.

    Продажа — в валюте рейса, закупка — в валюте поставщика: пересчёт
    делает расчёт, а не тот, кто собирал данные.
    """

    status: str
    plan_sale: Money | None
    plan_cost: Money | None
    fact_sale: Money | None
    fact_cost: Money | None


@dataclass(frozen=True, slots=True)
class Margin:
    mode: str
    revenue: Money
    cost: Money
    margin: Money
    margin_percent: Decimal | None
    plan_portion_percent: Decimal | None
    threshold_percent: Decimal
    is_below_threshold: bool


def _percent(part: Money, whole: Money) -> Decimal | None:
    if whole.is_zero:
        return None
    return (part.amount / whole.amount * 100).quantize(PERCENT_QUANT, rounding=ROUND_HALF_UP)


def compute(
    contributions: Iterable[Contribution],
    *,
    mode: str,
    currency: str,
    rates: Mapping[str, Decimal | str],
    threshold: Decimal,
    fees: Money | None = None,
    discounts: Money | None = None,
) -> Margin:
    """Маржа по вкладам заявок (`DOMAIN.md § 7.3`). Чистая функция."""
    # Порог приходит из настроек; у только что созданного объекта настроек
    # значение по умолчанию ещё строка, а не `Decimal`.
    threshold = Decimal(str(threshold))
    revenue = Money.zero(currency)
    plan_revenue = Money.zero(currency)
    cost = Money.zero(currency)

    for item in contributions:
        if item.status in EXCLUDED:
            continue
        completed = item.status == ServiceOrderStatus.COMPLETED
        use_fact = mode == "fact" or (mode == "mixed" and completed)
        if mode == "fact" and not completed:
            continue

        sale, purchase = (
            (item.fact_sale, item.fact_cost) if use_fact else (item.plan_sale, item.plan_cost)
        )
        if purchase is None or sale is None:
            continue
        sale_in = fx.convert(sale, currency, rates)
        revenue = revenue + sale_in
        cost = cost + fx.convert(purchase, currency, rates)
        if not use_fact:
            plan_revenue = plan_revenue + sale_in

    # Сборы и скидки уровня документа — только по факту, из счёта (ADR-023).
    if mode != "plan":
        if fees is not None:
            revenue = revenue + fx.convert(fees, currency, rates)
        if discounts is not None:
            revenue = revenue - fx.convert(discounts, currency, rates)

    revenue, cost = revenue.rounded(), cost.rounded()
    margin = (revenue - cost).rounded()
    margin_percent = _percent(margin, revenue)
    below = margin_percent < threshold if margin_percent is not None else margin.is_negative
    return Margin(
        mode=mode,
        revenue=revenue,
        cost=cost,
        margin=margin,
        margin_percent=margin_percent,
        plan_portion_percent=_percent(plan_revenue, revenue) if mode == "mixed" else None,
        threshold_percent=threshold,
        is_below_threshold=below,
    )


# ─────────────────────────── Данные из базы ───────────────────────────


def _money(amount: Decimal | None, currency: str) -> Money | None:
    if amount is None or not currency:
        return None
    return Money.of(amount, currency)


def _plan_sale(order: ServiceOrder, flight: Flight, rates: Mapping[str, Any]) -> Money | None:
    """Снимок продажи; у заявок, оформленных до снимков, — расчёт по тарифу."""
    snapshot = _money(order.sale_amount, order.sale_currency)
    if snapshot is not None or order.purchase_unit_amount is None:
        return snapshot
    from billing.services import tariffs

    moment = flight.std_utc if order.leg == "departure" else flight.sta_utc
    return tariffs.sale_price(
        order=order,
        client_id=flight.client_id,
        target_currency=flight.billing_currency,
        rates=rates,
        moment=moment,
        use_actual=False,
    ).amount


def _contributions(
    flight: Flight,
    orders: Iterable[ServiceOrder],
    lines: Mapping[str, DocumentLine],
    rates: Mapping[str, Any],
) -> list[Contribution]:
    from orders.services import costs

    contributions: list[Contribution] = []
    for order in orders:
        fact_sale: Money | None = None
        fact_cost: Money | None = None
        if order.status == ServiceOrderStatus.COMPLETED:
            line = lines.get(order.pk)
            fact_sale = (
                Money.of(line.amount, line.currency)
                if line is not None
                else _money(order.actual_sale_amount, flight.billing_currency)
            )
            fact_cost = _money(order.actual_cost_amount, order.purchase_currency) or (
                costs.actual_cost(order)
            )
        contributions.append(
            Contribution(
                status=order.status,
                plan_sale=_plan_sale(order, flight, rates),
                plan_cost=costs.planned_cost(order),
                fact_sale=fact_sale,
                fact_cost=fact_cost,
            )
        )
    return contributions


def _document_totals(invoices: Iterable[Invoice]) -> tuple[Money | None, Money | None]:
    """Сборы и скидки уровня документа по выставленным счетам рейса (ADR-023)."""
    fees: Money | None = None
    discounts: Money | None = None
    for invoice in invoices:
        fees = (fees or Money.zero(invoice.currency)) + Money.of(
            invoice.fees_amount, invoice.currency
        )
        discounts = (discounts or Money.zero(invoice.currency)) + Money.of(
            invoice.discount_amount, invoice.currency
        )
    return fees, discounts


def contributions_for(flight: Flight) -> tuple[list[Contribution], Money | None, Money | None]:
    """Вклады заявок рейса и сборы со скидками выставленных счетов."""
    lines = {
        line.service_order_id: line
        for line in DocumentLine.objects.filter(
            invoice__flight=flight, invoice__status__in=BILLED, service_order__isnull=False
        )
        if line.service_order_id is not None
    }
    orders = flight.service_orders.select_related("service", "flight")
    fees, discounts = _document_totals(flight.invoices.filter(status__in=BILLED))
    return _contributions(flight, orders, lines, fx.rates_for(flight)), fees, discounts


def margin_for(flight: Flight, mode: str = "mixed") -> Margin:
    contributions, fees, discounts = contributions_for(flight)
    return compute(
        contributions,
        mode=mode,
        currency=flight.billing_currency,
        rates=fx.rates_for(flight),
        threshold=Settings.get_solo().low_margin_threshold_percent,
        fees=fees,
        discounts=discounts,
    )


def fx_of(flight: Flight) -> dict[str, Any]:
    """Снимок курсов рейса в форме `FxSnapshot`: курс показывается рядом с маржой."""
    if (flight.fx_snapshot or {}).get("rates"):
        return dict(flight.fx_snapshot)
    return fx.snapshot(flight.std_utc.date())


def to_contract(result: Margin, flight: Flight) -> dict[str, Any]:
    """Форма `MarginResult` контракта."""
    return {
        "mode": result.mode,
        "currency": result.revenue.currency,
        "revenue": result.revenue.to_json(),
        "cost": result.cost.to_json(),
        "margin": result.margin.to_json(),
        "marginPercent": str(result.margin_percent) if result.margin_percent is not None else None,
        "planPortionPercent": (
            str(result.plan_portion_percent) if result.plan_portion_percent is not None else None
        ),
        "isBelowThreshold": result.is_below_threshold,
        "thresholdPercent": str(result.threshold_percent),
        "fx": fx_of(flight),
        "calculatedAt": clock.now().isoformat(),
    }


# ─────────────────────────── Кэш ───────────────────────────
#
# Маржа считается по запросу и кэшируется (`BACKEND.md § 7`). Кэш сбрасывают
# события, меняющие её составляющие: заявки, счета, тарифы клиента. Срок
# жизни ограничен на случай изменения, прошедшего мимо сервисов (массовое
# обновление выборки генератором), — устаревшая цифра живёт минуты, а не дни.


def _key(flight_id: str, mode: str) -> str:
    return f"soc:margin:v1:{flight_id}:{mode}"


def cached(flight: Flight, mode: str) -> dict[str, Any]:
    key = _key(flight.pk, mode)
    payload: dict[str, Any] | None = cache.get(key)
    if payload is None:
        payload = to_contract(margin_for(flight, mode), flight)
        cache.set(key, payload, CACHE_TTL_SECONDS)
    return payload


def invalidate(flight_id: str) -> None:
    cache.delete_many([_key(flight_id, mode) for mode in MODES])


def flight_changed(flight_id: str) -> None:
    """Составляющие маржи изменились: сбросить кэш и проверить порог.

    Проверка уходит в фоновую задачу после фиксации транзакции
    (`CLAUDE.md § 3` п. 13): уведомление о низкой марже по изменению,
    которое откатилось, вводило бы в заблуждение.
    """
    invalidate(flight_id)

    def schedule() -> None:
        from billing.tasks import check_margin

        check_margin.delay(flight_id)

    transaction.on_commit(schedule)


def client_tariffs_changed(client_id: str) -> None:
    from flights.models import Flight

    for flight_id in Flight.objects.filter(client_id=client_id).values_list("pk", flat=True):
        invalidate(flight_id)


def percents_for(flights: list[Flight]) -> dict[str, str | None]:
    """Процент маржи (`mixed`) по странице рейсов — для колонки расписания.

    Считается пачкой: заявки берутся из предзагрузки выборки рейсов, строки
    и итоги счетов — двумя запросами на всю страницу. Рейс, маржу которого
    не посчитать (нет курса), получает пусто, а не ноль.
    """
    keys = {flight.pk: _key(flight.pk, "mixed") for flight in flights}
    found: dict[str, dict[str, Any]] = cache.get_many(list(keys.values()))
    missing = [flight for flight in flights if keys[flight.pk] not in found]

    if missing:
        ids = [flight.pk for flight in missing]
        lines: dict[str, dict[str, DocumentLine]] = {flight_id: {} for flight_id in ids}
        for line in DocumentLine.objects.filter(
            invoice__flight_id__in=ids, invoice__status__in=BILLED, service_order__isnull=False
        ).select_related("invoice"):
            if line.invoice is not None and line.service_order_id is not None:
                lines[line.invoice.flight_id][line.service_order_id] = line
        invoices: dict[str, list[Invoice]] = {flight_id: [] for flight_id in ids}
        for invoice in Invoice.objects.filter(flight_id__in=ids, status__in=BILLED):
            invoices[invoice.flight_id].append(invoice)
        threshold = Settings.get_solo().low_margin_threshold_percent

        for flight in missing:
            try:
                rates = fx.rates_for(flight)
                fees, discounts = _document_totals(invoices[flight.pk])
                result = compute(
                    _contributions(flight, flight.service_orders.all(), lines[flight.pk], rates),
                    mode="mixed",
                    currency=flight.billing_currency,
                    rates=rates,
                    threshold=threshold,
                    fees=fees,
                    discounts=discounts,
                )
            except DomainError as error:
                logger.info("маржа рейса %s не посчитана: %s", flight.number, error)
                continue
            payload = to_contract(result, flight)
            cache.set(keys[flight.pk], payload, CACHE_TTL_SECONDS)
            found[keys[flight.pk]] = payload

    return {
        flight.pk: found[keys[flight.pk]]["marginPercent"] if keys[flight.pk] in found else None
        for flight in flights
    }
