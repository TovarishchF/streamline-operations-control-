"""Построение отчётов `[ТЗ 3.6.1]` (`SPEC.md § 9.1`).

Каждый отчёт — функция, возвращающая строки. Колонки и итоги берутся
из определения (`reports.definitions`), а не объявляются здесь: иначе
таблица на экране, заголовок выгрузки и XML-схема разошлись бы.

Суммы считаются в `Decimal` и отдаются десятичной строкой
(`CLAUDE.md § 3` п. 1). Проценты — тоже строкой: доля, посчитанная
в числе с плавающей точкой, в отчёте о марже недопустима.

Данных нет — отчёт пуст, а не заполнен нулями: пустая таблица говорит
«за период ничего не было», а таблица нулей выглядит как посчитанный
результат (`CLAUDE.md § 4`).
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db.models import Count, Q

from audit.models import AuditEntityType, AuditEntry
from billing.models import Invoice, InvoiceStatus
from core import clock
from core.exceptions import DomainError
from core.money import BASE_CURRENCY, DISPLAY_QUANT, SUPPORTED_CURRENCIES, Money
from flights.models import Flight
from orders.models import ServiceOrder, ServiceOrderStatus
from reports import definitions

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import date, datetime

class ReportParameterInvalid(DomainError):
    """Параметр отчёта вне допустимых значений."""

    code = "VALIDATION_ERROR"


# Корзины дебиторки по срокам (`SPEC.md § 9.1` п. 5).
BUCKETS = ((0, 30, "0–30"), (31, 60, "31–60"), (61, None, "60+"))


def _money(amount: Decimal | None, currency: str) -> str | None:
    """Денежная величина строкой с двумя знаками. `None` остаётся `None`."""
    if amount is None:
        return None
    return str(Money.of(amount, currency).amount.quantize(DISPLAY_QUANT))


def _percent(part: int | Decimal, whole: int | Decimal) -> str | None:
    """Доля в процентах. При нулевом знаменателе — `None`, а не ноль.

    Ноль означал бы «ни одной подтверждённой заявки», тогда как на деле
    заявок не было вовсе. Разница существенная: по первому показателю
    поставщика можно снять с обслуживания.
    """
    if not whole:
        return None
    value = (Decimal(part) / Decimal(whole) * 100).quantize(DISPLAY_QUANT)
    return str(value)


def _window(params: dict[str, Any]) -> tuple[datetime, datetime]:
    """Границы периода. Конец — включительно, до конца суток."""
    from datetime import UTC, datetime, time

    start: date = params["from"]
    end: date = params["to"]
    return (
        datetime.combine(start, time.min, tzinfo=UTC),
        datetime.combine(end, time.max, tzinfo=UTC),
    )


# ─────────────────────────── Рейсы за период ───────────────────────────


def flights_period(params: dict[str, Any]) -> list[dict[str, Any]]:
    start, end = _window(params)
    queryset = (
        Flight.objects.filter(std_utc__range=(start, end))
        .select_related("client", "aircraft")
        .annotate(service_count=Count("service_orders"))
        .order_by("std_utc")
    )
    if params.get("clientId"):
        queryset = queryset.filter(client_id=params["clientId"])

    return [
        {
            "number": flight.number,
            "client": flight.client.name,
            "aircraft": flight.aircraft.registration if flight.aircraft else None,
            "route": f"{flight.dep_icao} → {flight.arr_icao}",
            "std": flight.std_utc.isoformat(),
            "status": flight.get_status_display(),
            "services": flight.service_count,
        }
        for flight in queryset
    ]


# ─────────────────────────── Оказанные услуги ───────────────────────────


def services_rendered(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Группировка по категории, услуге, поставщику и аэропорту.

    В отчёт идут только выполненные заявки: «оказанные услуги» — это
    те, что оказаны, а не те, что заказаны.
    """
    start, end = _window(params)
    queryset = ServiceOrder.objects.filter(
        status=ServiceOrderStatus.COMPLETED, completed_at__range=(start, end)
    ).select_related("service", "vendor")

    if params.get("category"):
        queryset = queryset.filter(service__category=params["category"])
    if params.get("vendorId"):
        queryset = queryset.filter(vendor_id=params["vendorId"])

    grouped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for order in queryset:
        key = (
            order.service.category,
            order.service.code,
            order.vendor.name if order.vendor else "—",
            order.airport_icao,
        )
        bucket = grouped.setdefault(
            key,
            {
                "category": order.service.get_category_display(),
                "service": f"{order.service.name_ru} ({order.service.code})",
                "vendor": key[2],
                "airport": order.airport_icao,
                "count": 0,
                "quantity": Decimal(0),
                "cost": Decimal(0),
                "currency": order.purchase_currency or "RUB",
            },
        )
        bucket["count"] += 1
        bucket["quantity"] += order.actual_quantity or order.quantity
        bucket["cost"] += order.purchase_cost_amount or Decimal(0)

    rows = []
    for bucket in sorted(grouped.values(), key=lambda item: (item["category"], item["service"])):
        # Валюта остаётся в строке: закупка у разных поставщиков бывает
        # в разных валютах, и выгрузка обязана это показывать.
        currency = bucket["currency"]
        bucket["quantity"] = str(bucket["quantity"].quantize(DISPLAY_QUANT))
        bucket["cost"] = _money(bucket["cost"], currency)
        rows.append(bucket)
    return rows


# ─────────────────────────── Финансовый ───────────────────────────


def financial(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Доходы, расходы и маржа по рейсам (`DOMAIN.md § 7.3`).

    Те же цифры, что в карточке рейса в режиме «факт»: расчёт один
    (`billing.services.margin`), иначе отчёт и карточка расходились бы,
    и было бы непонятно, какой цифре верить. Выручка — по ценам клиента
    без НДС: налог не доход. Источник — строки выставленного счёта, а до
    его выставления — продажа, зафиксированная при выполнении услуги;
    черновик счёта в расчёт не идёт. Расход — закупка по фактическому
    количеству (ADR-020).

    Суммы приводятся к валюте представления (параметр `currency`, по
    умолчанию рубль) по снимку курсов каждого рейса: складывать доллары
    одного рейса с рублями другого в итоге нельзя.
    """
    from billing.services import fx
    from billing.services import margin as margin_service

    presentation = str(params.get("currency") or BASE_CURRENCY).upper()
    if presentation not in SUPPORTED_CURRENCIES:
        raise ReportParameterInvalid(
            f"Валюта представления {presentation} не поддерживается",
            {"currency": sorted(SUPPORTED_CURRENCIES)},
        )

    start, end = _window(params)
    queryset = Flight.objects.filter(std_utc__range=(start, end)).select_related("client")
    if params.get("clientId"):
        queryset = queryset.filter(client_id=params["clientId"])

    rows = []
    for flight in queryset.order_by("std_utc"):
        result = margin_service.margin_for(flight, "fact")
        rates = fx.rates_for(flight)
        revenue = fx.convert(result.revenue, presentation, rates).rounded()
        cost = fx.convert(result.cost, presentation, rates).rounded()
        margin = revenue - cost
        rows.append(
            {
                "flight": flight.number,
                "client": flight.client.name,
                "currency": presentation,
                "revenue": _money(revenue.amount, presentation),
                "cost": _money(cost.amount, presentation),
                "margin": _money(margin.amount, presentation),
                # Отрицательная маржа не ошибка и не обнуляется
                # (`DOMAIN.md § 7.3`), а нулевая выручка даёт `None`,
                # а не ноль процентов.
                "marginPercent": _percent(margin.amount, revenue.amount)
                if not revenue.is_zero
                else None,
            }
        )
    return rows


# ─────────────────────────── Поставщики ───────────────────────────


def vendors(params: dict[str, Any]) -> list[dict[str, Any]]:
    start, end = _window(params)
    queryset = (
        ServiceOrder.objects.filter(ordered_at__range=(start, end), vendor__isnull=False)
        .values("vendor_id", "vendor__name")
        .annotate(
            orders=Count("id"),
            completed=Count("id", filter=Q(status=ServiceOrderStatus.COMPLETED)),
            rejected=Count("id", filter=Q(status=ServiceOrderStatus.REJECTED)),
            breaches=Count("id", filter=Q(sla_breached=True)),
            confirmed=Count("id", filter=Q(confirmed_at__isnull=False)),
            on_time=Count("id", filter=Q(confirmed_at__isnull=False, sla_breached=False)),
        )
        .order_by("-orders")
    )

    volume: dict[str, Decimal] = defaultdict(Decimal)
    currency: dict[str, str] = {}
    for order in ServiceOrder.objects.filter(
        ordered_at__range=(start, end), vendor__isnull=False
    ):
        # Выборка отсекает заявки без поставщика, поэтому связь заполнена;
        # проверка нужна только для статического анализа.
        vendor_id = order.vendor_id
        if vendor_id is None:
            continue
        volume[vendor_id] += order.purchase_cost_amount or Decimal(0)
        currency.setdefault(vendor_id, order.purchase_currency or "RUB")

    return [
        {
            "vendor": row["vendor__name"],
            "orders": row["orders"],
            "completed": row["completed"],
            "rejected": row["rejected"],
            "slaBreaches": row["breaches"],
            "onTimeRate": _percent(row["on_time"], row["confirmed"]),
            "currency": currency.get(row["vendor_id"], "RUB"),
            "volume": _money(volume[row["vendor_id"]], currency.get(row["vendor_id"], "RUB")),
        }
        for row in queryset
    ]


# ─────────────────── Дебиторская и кредиторская ───────────────────


def _bucket_for(days_overdue: int) -> str:
    for low, high, label in BUCKETS:
        if days_overdue >= low and (high is None or days_overdue <= high):
            return label
    return BUCKETS[-1][2]


def receivables_payables(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Задолженность с разбивкой по срокам `[ТЗ 3.6.1]`.

    Дебиторка — выставленные и неоплаченные счета клиентам. Кредиторка
    (заявки на оплату поставщикам) появится вместе с платежами; пока
    в отчёте только дебиторка, и об этом сказано в примечании отчёта,
    а не умолчано.
    """
    from datetime import UTC, datetime, time

    as_of_date = params.get("asOf") or clock.now().date()
    as_of = datetime.combine(as_of_date, time.max, tzinfo=UTC)

    rows = []
    invoices = (
        Invoice.objects.filter(due_date__isnull=False)
        .exclude(status__in=[InvoiceStatus.DRAFT, InvoiceStatus.VOIDED, InvoiceStatus.PAID])
        .select_related("client")
        .order_by("due_date")
    )
    from billing.services import payments

    for invoice in invoices:
        assert invoice.due_date is not None
        # Долг — неоплаченный остаток, а не итог счёта (ADR-019): частично
        # оплаченный счёт должен клиенту только разницу.
        outstanding = invoice.total_amount - payments.paid_amount(invoice)
        if outstanding <= payments.TOLERANCE:
            continue
        overdue_days = max(0, (as_of - invoice.due_date).days)
        rows.append(
            {
                "counterparty": invoice.client.name,
                "kind": "Дебиторская",
                "document": invoice.number or invoice.pk,
                "dueDate": invoice.due_date.isoformat(),
                "bucket": _bucket_for(overdue_days),
                "currency": invoice.currency,
                "amount": _money(outstanding, invoice.currency),
            }
        )
    return rows


# ─────────────────────────── Нарушения SLA ───────────────────────────


def sla_breaches(params: dict[str, Any]) -> list[dict[str, Any]]:
    start, end = _window(params)
    queryset = (
        ServiceOrder.objects.filter(sla_breached=True, ordered_at__range=(start, end))
        .select_related("flight", "service", "vendor")
        .order_by("sla_confirm_deadline")
    )
    if params.get("vendorId"):
        queryset = queryset.filter(vendor_id=params["vendorId"])

    rows = []
    for order in queryset:
        late_hours = None
        if order.confirmed_at and order.sla_confirm_deadline:
            late_hours = round(
                (order.confirmed_at - order.sla_confirm_deadline).total_seconds() / 3600, 1
            )
        rows.append(
            {
                "flight": order.flight.number,
                "service": f"{order.service.name_ru} ({order.service.code})",
                "vendor": order.vendor.name if order.vendor else "—",
                "deadline": (
                    order.sla_confirm_deadline.isoformat()
                    if order.sla_confirm_deadline
                    else None
                ),
                "confirmedAt": order.confirmed_at.isoformat() if order.confirmed_at else None,
                "lateHours": late_hours,
            }
        )
    return rows


# ─────────────────────────── Журнал изменений ───────────────────────────


def flight_audit(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Выгрузка из аудита по рейсам и заявкам за период `[ТЗ 3.6.1]`.

    Записи генератора данных помечены автором «Система (генератор данных)»
    и за действия людей не выдаются (`CLAUDE.md § 4`).
    """
    start, end = _window(params)
    queryset = AuditEntry.objects.filter(
        ts__range=(start, end),
        entity_type__in=[AuditEntityType.FLIGHT, AuditEntityType.SERVICE_ORDER],
    ).order_by("-ts")

    if params.get("flightId"):
        queryset = queryset.filter(entity_id=params["flightId"])

    return [
        {
            "ts": entry.ts.isoformat(),
            "actor": entry.actor_name,
            "entity": entry.get_entity_type_display(),
            "action": entry.action,
            "comment": entry.comment,
        }
        for entry in queryset[:1000]
    ]


BUILDERS: dict[str, Callable[[dict[str, Any]], list[dict[str, Any]]]] = {
    definitions.FLIGHTS_PERIOD: flights_period,
    definitions.SERVICES_RENDERED: services_rendered,
    definitions.FINANCIAL: financial,
    definitions.VENDORS: vendors,
    definitions.RECEIVABLES_PAYABLES: receivables_payables,
    definitions.SLA_BREACHES: sla_breaches,
    definitions.FLIGHT_AUDIT: flight_audit,
}


def build(code: str, params: dict[str, Any]) -> dict[str, Any]:
    """Результат отчёта в форме `ReportResult` из контракта."""
    spec = definitions.definition(code)
    builder = BUILDERS[code]
    rows = builder(params)

    return {
        "code": code,
        "generatedAt": clock.now().isoformat(),
        "currency": params.get("currency") or "RUB",
        "columns": spec.columns_to_contract(),
        "rows": rows,
        "totals": totals_for(spec, rows),
    }


def totals_for(spec: definitions.Definition, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Итоги по объявленным колонкам.

    Суммируются уже посчитанные значения строк, а не исходные величины:
    «итого» обязано сходиться с колонкой на экране (ADR-002 п. 3).
    """
    totals: dict[str, Any] = {}
    for key in spec.totals:
        column = next((c for c in spec.columns if c.key == key), None)
        if column is None:
            continue
        if column.type == "money":
            total = sum(
                (Decimal(str(row[key])) for row in rows if row.get(key) is not None),
                Decimal(0),
            )
            totals[key] = str(total.quantize(DISPLAY_QUANT))
        else:
            totals[key] = sum(
                (row[key] for row in rows if isinstance(row.get(key), int | float)), 0
            )
    return totals
