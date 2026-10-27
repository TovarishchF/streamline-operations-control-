"""Дашборды диспетчера и руководителя `[ТЗ 3.6.2]` (`SPEC.md § 9.2`).

Диспетчер работает с текущей обстановкой, и его виджеты строятся живыми
запросами: рейс, отменённый минуту назад, не должен висеть в «ближайших».

Руководитель смотрит деньги за период по сотням рейсов, и его виджеты
читают агрегатный путь маржи — материализованные представления
`reports_order_margin` и `reports_flight_margin` (ADR-012), которые
обновляет задача `reports.refresh_views`. Время последнего обновления
отдаётся в `generatedAt`: цифра, посчитанная пять минут назад, честно
подписана как пятиминутная.

Суммы руководителя приведены к рублю по снимку курсов каждого рейса
(`SPEC.md § 7.4`). Виджет, который не удалось посчитать (нет курса),
возвращает объяснение, а не ломает весь дашборд.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.core.cache import cache
from django.db import connection
from django.db.models import Q

from billing.services import fx
from core import clock
from core.exceptions import DomainError
from core.models import Settings
from core.money import BASE_CURRENCY, Money

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import User

logger = logging.getLogger(__name__)

REFRESHED_AT_KEY = "soc:dashboards:refreshed_at"
GRID_COLUMNS = 12
UPCOMING_LIMIT = 6
TOP_LIMIT = 6
SLA_SOON = timedelta(hours=2)
CONFLICT_HORIZON = timedelta(days=7)
MANAGER_WINDOW = timedelta(days=30)
SERIES_WEEKS = 8
PERCENT_QUANT = Decimal("0.01")
BUCKETS = ((0, 30, "0–30"), (31, 60, "31–60"), (61, None, "60+"))


@dataclass(frozen=True, slots=True)
class Widget:
    code: str
    ru: str
    en: str
    # Положение по умолчанию на сетке в 12 колонок.
    x: int
    y: int
    w: int
    h: int


DISPATCHER_WIDGETS = (
    Widget("flights_today", "Рейсы сегодня", "Flights today", 0, 0, 3, 2),
    Widget("unconfirmed", "Неподтверждённые заявки", "Unconfirmed orders", 3, 0, 3, 2),
    Widget("sla_breaches", "Нарушения SLA за сутки", "SLA breaches, 24 h", 6, 0, 3, 2),
    Widget(
        "aircraft_out_of_service",
        "Борта в AOG и на ТО",
        "Aircraft AOG and in maintenance",
        9,
        0,
        3,
        2,
    ),
    Widget("upcoming", "Ближайшие вылеты", "Upcoming departures", 0, 2, 7, 5),
    Widget("conflicts", "Конфликты расписания", "Schedule conflicts", 7, 2, 5, 5),
    Widget("flights_by_status", "Рейсы сегодня по статусам", "Today by status", 0, 7, 6, 3),
    Widget("lead_time_overdue", "Просроченный лидтайм", "Lead time overdue", 6, 7, 6, 3),
)

MANAGER_WIDGETS = (
    Widget("flights_count", "Рейсы и динамика", "Flights and trend", 0, 0, 3, 3),
    Widget("margin_summary", "Маржа", "Margin", 3, 0, 9, 3),
    Widget("margin_health", "Маржа ниже порога", "Margin below threshold", 0, 3, 4, 3),
    Widget("fleet_usage", "Загрузка парка", "Fleet utilisation", 4, 3, 4, 3),
    Widget(
        "category_margin", "Маржа по категориям услуг", "Margin by service category", 8, 3, 4, 3
    ),
    Widget("top_clients", "Топ клиентов", "Top clients", 0, 6, 6, 4),
    Widget("top_vendors", "Топ поставщиков по обороту", "Top vendors by turnover", 6, 6, 6, 4),
    Widget("receivables", "Дебиторская задолженность", "Receivables", 0, 10, 6, 3),
    Widget("payables", "Кредиторская задолженность", "Payables", 6, 10, 6, 3),
)

WIDGETS: dict[str, tuple[Widget, ...]] = {
    "dispatcher": DISPATCHER_WIDGETS,
    "manager": MANAGER_WIDGETS,
}


class LayoutInvalid(DomainError):
    """Раскладка ссылается на чужой виджет или выходит за сетку."""

    code = "VALIDATION_ERROR"


# ─────────────────────────── Раскладка ───────────────────────────


def default_layout(role: str) -> list[dict[str, Any]]:
    return [
        {"code": item.code, "x": item.x, "y": item.y, "w": item.w, "h": item.h}
        for item in WIDGETS[role]
    ]


def layout_for(user: User, role: str) -> list[dict[str, Any]]:
    from reports.models import DashboardLayout

    saved = DashboardLayout.objects.filter(user=user, role=role).first()
    if saved is None:
        return default_layout(role)
    known = {item.code for item in WIDGETS[role]}
    # Виджет, убранный из состава в новой версии, из сохранённой раскладки
    # молча выпадает: показывать пустое место на его месте незачем.
    return [item for item in saved.widgets if item.get("code") in known]


def validate_layout(role: str, widgets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    known = {item.code for item in WIDGETS[role]}
    seen: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for item in widgets:
        code = str(item.get("code", ""))
        if code not in known:
            raise LayoutInvalid(f"Виджета {code} на этом дашборде нет", {"code": code})
        if code in seen:
            raise LayoutInvalid(f"Виджет {code} указан дважды", {"code": code})
        seen.add(code)
        x, y, w, h = (int(item[key]) for key in ("x", "y", "w", "h"))
        if w < 1 or h < 1 or x < 0 or y < 0 or x + w > GRID_COLUMNS:
            raise LayoutInvalid(
                f"Виджет {code} выходит за сетку в {GRID_COLUMNS} колонок", {"code": code}
            )
        cleaned.append({"code": code, "x": x, "y": y, "w": w, "h": h})
    return cleaned


def save_layout(user: User, role: str, widgets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from reports.models import DashboardLayout

    cleaned = validate_layout(role, widgets)
    DashboardLayout.objects.update_or_create(user=user, role=role, defaults={"widgets": cleaned})
    return cleaned


# ─────────────────────────── Сборка ───────────────────────────


def data_for(user: User, role: str) -> dict[str, Any]:
    """Данные всех виджетов роли и раскладка пользователя (`DashboardData`)."""
    builders: dict[str, Callable[[User], dict[str, Any]]] = (
        DISPATCHER_BUILDERS if role == "dispatcher" else MANAGER_BUILDERS
    )
    widgets = []
    for item in WIDGETS[role]:
        try:
            data = builders[item.code](user)
        except DomainError as error:
            logger.warning("виджет %s не посчитан: %s", item.code, error)
            data = {"error": {"code": error.code, "message": str(error)}}
        widgets.append({"code": item.code, "title": {"ru": item.ru, "en": item.en}, "data": data})

    generated = clock.now() if role == "dispatcher" else refreshed_at()
    return {
        "widgets": widgets,
        "generatedAt": generated.isoformat() if generated else None,
        "layout": {"widgets": layout_for(user, role)},
    }


def _money(value: Money) -> dict[str, str]:
    return value.rounded().to_json()


def _percent(part: Decimal, whole: Decimal) -> str | None:
    if whole == 0:
        return None
    return str((part / whole * 100).quantize(PERCENT_QUANT, rounding=ROUND_HALF_UP))


def _zone(user: User) -> ZoneInfo:
    try:
        return ZoneInfo(user.timezone or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


# ─────────────────────────── Диспетчер ───────────────────────────


def _today_window(user: User) -> tuple[datetime, datetime]:
    """Сегодняшние сутки в зоне пользователя, в UTC."""
    zone = _zone(user)
    local = clock.now().astimezone(zone)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(ZoneInfo("UTC")), (start + timedelta(days=1)).astimezone(
        ZoneInfo("UTC")
    )


def _today_flights(user: User) -> Any:
    from flights.models import Flight

    start, end = _today_window(user)
    return Flight.objects.filter(std_utc__gte=start, std_utc__lt=end)


def flights_today(user: User) -> dict[str, Any]:
    start, end = _today_window(user)
    flights = _today_flights(user)
    return {"count": flights.count(), "from": start.isoformat(), "to": end.isoformat()}


def flights_by_status(user: User) -> dict[str, Any]:
    from django.db.models import Count

    rows = _today_flights(user).values("status").annotate(count=Count("id")).order_by("-count")
    return {"items": [{"status": row["status"], "count": row["count"]} for row in rows]}


def upcoming(user: User) -> dict[str, Any]:
    from flights.models import Flight, FlightStatus

    current = clock.now()
    queryset = (
        Flight.objects.filter(std_utc__gt=current)
        .exclude(status__in=(FlightStatus.CANCELLED, FlightStatus.COMPLETED))
        .select_related("aircraft", "aircraft__type")
        .order_by("std_utc")
    )
    return {
        "total": queryset.count(),
        "items": [
            {
                "id": flight.pk,
                "number": flight.number,
                "aircraftRegistration": flight.aircraft.registration if flight.aircraft else None,
                "aircraftType": flight.aircraft.type.icao_type if flight.aircraft else None,
                "depIcao": flight.dep_icao,
                "arrIcao": flight.arr_icao,
                "stdUtc": flight.std_utc.isoformat(),
                "staUtc": flight.sta_utc.isoformat(),
                "status": flight.status,
            }
            for flight in queryset[:UPCOMING_LIMIT]
        ],
    }


def _order_item(order: Any) -> dict[str, Any]:
    return {
        "orderId": order.pk,
        "flightId": order.flight_id,
        "flightNumber": order.flight.number,
        "serviceName": {"ru": order.service.name_ru, "en": order.service.name_en},
        "vendorName": order.vendor.name if order.vendor else None,
        "slaConfirmDeadline": (
            order.sla_confirm_deadline.isoformat() if order.sla_confirm_deadline else None
        ),
    }


def unconfirmed(user: User) -> dict[str, Any]:
    from orders.models import ServiceOrder, ServiceOrderStatus

    current = clock.now()
    waiting = ServiceOrder.objects.filter(status=ServiceOrderStatus.ORDERED)
    active = ServiceOrder.objects.exclude(
        status__in=(
            ServiceOrderStatus.COMPLETED,
            ServiceOrderStatus.CANCELLED,
            ServiceOrderStatus.REJECTED,
        )
    )
    return {
        "count": waiting.count(),
        "activeTotal": active.count(),
        "dueSoon": waiting.filter(
            sla_confirm_deadline__gte=current, sla_confirm_deadline__lt=current + SLA_SOON
        ).count(),
    }


def lead_time_overdue(user: User) -> dict[str, Any]:
    """Заявки без подтверждения, до оказания которых меньше лидтайма."""
    from orders.models import ServiceOrder, ServiceOrderStatus

    current = clock.now()
    orders = (
        ServiceOrder.objects.filter(
            status__in=(ServiceOrderStatus.DRAFT, ServiceOrderStatus.ORDERED),
            flight__std_utc__gt=current,
        )
        .select_related("flight", "service", "vendor")
        .order_by("flight__std_utc")
    )
    items = []
    for order in orders:
        moment = order.flight.std_utc if order.leg == "departure" else order.flight.sta_utc
        if moment - current < timedelta(hours=order.service.lead_time_h):
            items.append({**_order_item(order), "serviceAt": moment.isoformat()})
    return {"count": len(items), "items": items[: TOP_LIMIT * 2]}


def sla_breaches(user: User) -> dict[str, Any]:
    from orders.models import ServiceOrder

    since = clock.now() - timedelta(days=1)
    orders = (
        ServiceOrder.objects.filter(sla_breached=True)
        .filter(Q(sla_confirm_deadline__gte=since) | Q(confirmed_at__gte=since))
        .select_related("flight", "service", "vendor")
        .order_by("-sla_confirm_deadline")
    )
    return {"count": orders.count(), "items": [_order_item(order) for order in orders[:20]]}


def aircraft_out_of_service(user: User) -> dict[str, Any]:
    from fleet.models import Aircraft, AircraftStatus

    aircraft = Aircraft.objects.exclude(status=AircraftStatus.SERVICEABLE).order_by(
        "status", "registration"
    )
    return {
        "count": aircraft.count(),
        "items": [
            {
                "id": item.pk,
                "registration": item.registration,
                "status": item.status,
                "notes": item.notes,
            }
            for item in aircraft
        ],
    }


def conflicts(user: User) -> dict[str, Any]:
    from flights.api.serializers import conflict_payload
    from flights.models import Flight
    from flights.services import conflicts as detector

    current = clock.now()
    flights = (
        Flight.objects.filter(std_utc__gte=current, std_utc__lte=current + CONFLICT_HORIZON)
        .select_related("aircraft", "aircraft__type")
        .prefetch_related("aircraft__approvals")
        .order_by("std_utc")
    )
    items = []
    for flight in flights:
        for found in detector.detect(flight):
            items.append({**conflict_payload(flight, found), "flightNumber": flight.number})
    return {"count": len(items), "horizonDays": CONFLICT_HORIZON.days, "items": items}


DISPATCHER_BUILDERS: dict[str, Callable[[User], dict[str, Any]]] = {
    "flights_today": flights_today,
    "flights_by_status": flights_by_status,
    "upcoming": upcoming,
    "unconfirmed": unconfirmed,
    "lead_time_overdue": lead_time_overdue,
    "sla_breaches": sla_breaches,
    "aircraft_out_of_service": aircraft_out_of_service,
    "conflicts": conflicts,
}


# ─────────────────────────── Руководитель ───────────────────────────


def refresh_views() -> datetime:
    """Обновляет агрегатный путь маржи. Порядок важен: рейсы считаются из заявок."""
    with connection.cursor() as cursor:
        cursor.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY reports_order_margin")
        cursor.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY reports_flight_margin")
    stamp = clock.now()
    cache.set(REFRESHED_AT_KEY, stamp.isoformat(), None)
    return stamp


def refreshed_at() -> datetime | None:
    raw = cache.get(REFRESHED_AT_KEY)
    return datetime.fromisoformat(raw) if raw else None


def _fetch(sql: str, params: list[Any]) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        names = [column[0] for column in cursor.description or ()]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def _rates(raw: Any) -> dict[str, Any]:
    import json

    if isinstance(raw, str):
        loaded: dict[str, Any] = json.loads(raw)
        return loaded
    return dict(raw or {})


def _to_rub(amount: Decimal, currency: str, rates: Any) -> Money:
    return fx.convert(Money.of(amount, currency), BASE_CURRENCY, _rates(rates))


def flight_rows(since: datetime, until: datetime) -> list[dict[str, Any]]:
    """Итоги рейсов за период из агрегатного пути, в рублях."""
    rows = _fetch(
        "SELECT flight_id, client_id, aircraft_id, std_utc, currency, rates, revenue, cost "
        "FROM reports_flight_margin WHERE std_utc >= %s AND std_utc < %s",
        [since, until],
    )
    for row in rows:
        row["revenue_rub"] = _to_rub(row["revenue"], row["currency"], row["rates"])
        row["cost_rub"] = _to_rub(row["cost"], row["currency"], row["rates"])
    return rows


def _window() -> tuple[datetime, datetime]:
    current = clock.now()
    return current - MANAGER_WINDOW, current


def flights_count(user: User) -> dict[str, Any]:
    from flights.models import Flight

    current = clock.now()
    start = current - timedelta(weeks=SERIES_WEEKS)
    series = []
    for week in range(SERIES_WEEKS):
        week_start = start + timedelta(weeks=week)
        series.append(
            {
                "weekStart": week_start.isoformat(),
                "count": Flight.objects.filter(
                    std_utc__gte=week_start, std_utc__lt=week_start + timedelta(weeks=1)
                ).count(),
            }
        )
    since, until = _window()
    return {
        "total": Flight.objects.filter(std_utc__gte=since, std_utc__lt=until).count(),
        "series": series,
    }


def margin_summary(user: User) -> dict[str, Any]:
    current = clock.now()
    start = current - timedelta(weeks=SERIES_WEEKS)
    rows = flight_rows(start, current)
    since, _until = _window()

    def totals(items: list[dict[str, Any]]) -> dict[str, Any]:
        revenue = sum((row["revenue_rub"] for row in items), Money.zero(BASE_CURRENCY)).rounded()
        cost = sum((row["cost_rub"] for row in items), Money.zero(BASE_CURRENCY)).rounded()
        margin = revenue - cost
        return {
            "revenue": _money(revenue),
            "cost": _money(cost),
            "margin": _money(margin),
            "marginPercent": _percent(margin.amount, revenue.amount),
        }

    series = []
    for week in range(SERIES_WEEKS):
        week_start = start + timedelta(weeks=week)
        week_end = week_start + timedelta(weeks=1)
        series.append(
            {
                "weekStart": week_start.isoformat(),
                **totals([row for row in rows if week_start <= row["std_utc"] < week_end]),
            }
        )
    return {
        "currency": BASE_CURRENCY,
        **totals([row for row in rows if row["std_utc"] >= since]),
        "series": series,
    }


def margin_health(user: User) -> dict[str, Any]:
    threshold = Decimal(str(Settings.get_solo().low_margin_threshold_percent))
    rows = [row for row in flight_rows(*_window()) if row["revenue"] or row["cost"]]
    below = negative = 0
    for row in rows:
        margin = row["revenue"] - row["cost"]
        if margin < 0:
            negative += 1
        if row["revenue"] == 0 or margin / row["revenue"] * 100 < threshold:
            below += 1
    return {
        "total": len(rows),
        "belowThreshold": below,
        "negative": negative,
        "thresholdPercent": str(threshold),
    }


def fleet_usage(user: User) -> dict[str, Any]:
    from fleet.models import Aircraft

    since, until = _window()
    used = {row["aircraft_id"] for row in flight_rows(since, until) if row["aircraft_id"]}
    return {"used": len(used), "total": Aircraft.objects.count()}


def category_margin(user: User) -> dict[str, Any]:
    since, until = _window()
    rows = _fetch(
        "SELECT category, currency, rates, sale, cost FROM reports_order_margin "
        "WHERE std_utc >= %s AND std_utc < %s",
        [since, until],
    )
    sums: dict[str, list[Money]] = defaultdict(
        lambda: [Money.zero(BASE_CURRENCY), Money.zero(BASE_CURRENCY)]
    )
    for row in rows:
        bucket = sums[row["category"]]
        bucket[0] = bucket[0] + _to_rub(row["sale"], row["currency"], row["rates"])
        bucket[1] = bucket[1] + _to_rub(row["cost"], row["currency"], row["rates"])
    items = []
    for category, (sale, cost) in sorted(sums.items()):
        revenue, spent = sale.rounded(), cost.rounded()
        margin = revenue - spent
        items.append(
            {
                "category": category,
                "revenue": _money(revenue),
                "cost": _money(spent),
                "margin": _money(margin),
                "marginPercent": _percent(margin.amount, revenue.amount),
            }
        )
    return {"currency": BASE_CURRENCY, "items": items}


def top_clients(user: User) -> dict[str, Any]:
    from counterparties.models import Client

    grouped: dict[str, dict[str, Any]] = {}
    for row in flight_rows(*_window()):
        entry = grouped.setdefault(
            row["client_id"],
            {
                "revenue": Money.zero(BASE_CURRENCY),
                "cost": Money.zero(BASE_CURRENCY),
                "flights": 0,
            },
        )
        entry["revenue"] = entry["revenue"] + row["revenue_rub"]
        entry["cost"] = entry["cost"] + row["cost_rub"]
        entry["flights"] += 1
    names = dict(Client.objects.filter(pk__in=grouped).values_list("pk", "name"))
    items = []
    for client_id, entry in grouped.items():
        revenue, cost = entry["revenue"].rounded(), entry["cost"].rounded()
        margin = revenue - cost
        items.append(
            {
                "clientId": client_id,
                "name": names.get(client_id, client_id),
                "flights": entry["flights"],
                "revenue": _money(revenue),
                "margin": _money(margin),
                "marginPercent": _percent(margin.amount, revenue.amount),
                "_revenue": revenue.amount,
                "_margin": margin.amount,
            }
        )

    def public(item: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in item.items() if not key.startswith("_")}

    return {
        "currency": BASE_CURRENCY,
        "byRevenue": [
            public(item)
            for item in sorted(items, key=lambda item: item["_revenue"], reverse=True)[:TOP_LIMIT]
        ],
        "byMargin": [
            public(item)
            for item in sorted(items, key=lambda item: item["_margin"], reverse=True)[:TOP_LIMIT]
        ],
    }


def top_vendors(user: User) -> dict[str, Any]:
    from counterparties.models import Vendor
    from counterparties.services import rating

    since, until = _window()
    rows = _fetch(
        "SELECT vendor_id, currency, rates, cost FROM reports_order_margin "
        "WHERE std_utc >= %s AND std_utc < %s AND vendor_id IS NOT NULL",
        [since, until],
    )
    turnover: dict[str, Money] = defaultdict(lambda: Money.zero(BASE_CURRENCY))
    for row in rows:
        turnover[row["vendor_id"]] = turnover[row["vendor_id"]] + _to_rub(
            row["cost"], row["currency"], row["rates"]
        )
    leaders = sorted(turnover.items(), key=lambda pair: pair[1].amount, reverse=True)[:TOP_LIMIT]
    vendors = {
        vendor.pk: vendor for vendor in Vendor.objects.filter(pk__in=[k for k, _ in leaders])
    }
    items = []
    for vendor_id, amount in leaders:
        vendor = vendors.get(vendor_id)
        rated = rating.rating_for(vendor) if vendor is not None else None
        items.append(
            {
                "vendorId": vendor_id,
                "name": vendor.name if vendor is not None else vendor_id,
                "turnover": _money(amount),
                "rating": str(rated.rating) if rated is not None and rated.rating else None,
                "sufficientData": bool(rated and rated.sufficient_data),
            }
        )
    return {"currency": BASE_CURRENCY, "items": items}


def _bucket(days_overdue: int) -> str:
    for low, high, label in BUCKETS:
        if days_overdue >= low and (high is None or days_overdue <= high):
            return label
    return BUCKETS[-1][2]


def _empty_buckets() -> dict[str, Money]:
    return {label: Money.zero(BASE_CURRENCY) for _low, _high, label in BUCKETS}


def receivables(user: User) -> dict[str, Any]:
    """Неоплаченные остатки счетов клиентам по срокам, в рублях по курсу счёта."""
    from billing.models import Invoice
    from billing.services import payments

    current = clock.now()
    buckets = _empty_buckets()
    for invoice in Invoice.objects.filter(
        status__in=payments.PAYABLE_STATUSES, due_date__isnull=False
    ):
        outstanding = invoice.total_amount - payments.paid_amount(invoice)
        if outstanding <= payments.TOLERANCE:
            continue
        assert invoice.due_date is not None
        rates = (invoice.fx_snapshot or {}).get("rates") or fx.snapshot()["rates"]
        label = _bucket(max(0, (current - invoice.due_date).days))
        buckets[label] = buckets[label] + fx.convert(
            Money.of(outstanding, invoice.currency), BASE_CURRENCY, rates
        )
    return {
        "currency": BASE_CURRENCY,
        "items": [{"bucket": label, "amount": _money(amount)} for label, amount in buckets.items()],
    }


def payables(user: User) -> dict[str, Any]:
    """Неоплаченные заявки на оплату поставщикам по срокам.

    У заявки на оплату нет своего снимка курса: пересчёт в рубли — по
    сегодняшнему, и это подписано в данных виджета.
    """
    from billing.models import Payable, PayableStatus

    current = clock.now()
    rates = fx.snapshot()["rates"]
    buckets = _empty_buckets()
    for payable in Payable.objects.exclude(
        status__in=(PayableStatus.PAID, PayableStatus.CANCELLED)
    ):
        label = _bucket(max(0, (current - payable.due_date).days))
        buckets[label] = buckets[label] + fx.convert(
            Money.of(payable.amount, payable.currency), BASE_CURRENCY, rates
        )
    return {
        "currency": BASE_CURRENCY,
        "rateDate": current.date().isoformat(),
        "items": [{"bucket": label, "amount": _money(amount)} for label, amount in buckets.items()],
    }


MANAGER_BUILDERS: dict[str, Callable[[User], dict[str, Any]]] = {
    "flights_count": flights_count,
    "margin_summary": margin_summary,
    "margin_health": margin_health,
    "fleet_usage": fleet_usage,
    "category_margin": category_margin,
    "top_clients": top_clients,
    "top_vendors": top_vendors,
    "receivables": receivables,
    "payables": payables,
}
