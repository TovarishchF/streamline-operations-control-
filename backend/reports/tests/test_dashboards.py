"""Дашборды диспетчера и руководителя `[ТЗ 3.6.2]` (`SPEC.md § 9.2`, ADR-012).

ADR-012: агрегатный путь маржи (материализованные представления на NUMERIC)
сверяется с каноничным (чистая функция на Decimal) — расхождение хотя бы
в копейку на одном рейсе валит сборку.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from django.db import connection
from rest_framework import status

from accounts.models import Role
from billing.models import TariffMode, TariffRule
from billing.services import documents, fx
from billing.services import margin as margin_service
from catalog.models import Service, ServiceCategory, ServiceUnit, VendorPrice
from core.clock import now
from core.money import Money
from fleet.models import AircraftStatus
from flights.models import Flight
from orders.models import ServiceOrder
from orders.services import orders as order_services
from orders.services import transitions
from reports.services import dashboards

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import Organization, User
    from counterparties.models import Client, Vendor, VendorContract
    from fleet.models import Aircraft

pytestmark = pytest.mark.django_db

RATES = {"RUB": "1.0000", "USD": "90.1234", "EUR": "99.8765"}


def place(
    flight: Flight, service: Service, vendor: Vendor, actor: User, quantity: str = "1000"
) -> ServiceOrder:
    return order_services.create_order(
        flight=flight,
        service=service,
        leg="departure",
        quantity=Decimal(quantity),
        vendor=vendor,
        attributes={},
        # Рейсы набора — вчера и через час: лидтайм нарушен, и это
        # подтверждается причиной, как в работе.
        override_reason="Срочный заказ",
        actor=actor,
    )


def complete(order: ServiceOrder, actor: User, actual: str) -> ServiceOrder:
    transitions.apply_transition(order, "confirm", actor=actor)
    transitions.apply_transition(order, "begin", actor=actor)
    started = now() - timedelta(hours=1)
    order = order_services.update_order(
        order=order,
        changes={
            "actual_start_at": started,
            "actual_end_at": started + timedelta(minutes=40),
            "actual_quantity": Decimal(actual),
        },
        actor=actor,
    )
    transitions.apply_transition(order, "finish", actor=actor)
    return ServiceOrder.objects.get(pk=order.pk)


def make_flight(
    organization: Organization,
    client: Client,
    aircraft: Aircraft,
    number: str,
    currency: str,
    *,
    days: float,
) -> Flight:
    departure = now() + timedelta(days=days)
    return Flight.objects.create(
        organization=organization,
        number=number,
        client=client,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=3,
        billing_currency=currency,
        fx_snapshot={"date": departure.date().isoformat(), "base": "RUB", "rates": RATES},
    )


@pytest.fixture
def varied_set(
    organization: Organization,
    client_alpha: Client,
    client_beta: Client,
    aircraft: Aircraft,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
    make_user: Callable[..., User],
) -> list[Flight]:
    """Рейсы в рублях и долларах, план и факт, счёт, отмена, черновик с ценой.

    Курсы с «неровными» знаками — чтобы округление пересчёта валюты было
    видно, а не пряталось за круглыми числами.
    """
    handling = Service.objects.create(
        code="HND-RAMP",
        category=ServiceCategory.HANDLING,
        name_ru="Перронное обслуживание",
        name_en="Ramp handling",
        unit=ServiceUnit.FLIGHT,
        lead_time_h=2,
    )
    VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=handling,
        airport_icao="UUWW",
        amount=Decimal("12345.6789"),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
    )
    TariffRule.objects.create(
        client=client_alpha,
        category="fuel",
        mode=TariffMode.COST_PLUS,
        markup_percent=Decimal("7.3"),
        valid_from=now() - timedelta(days=60),
        valid_to=now() + timedelta(days=365),
    )
    TariffRule.objects.create(
        client=client_beta,
        service=handling,
        mode=TariffMode.FIXED,
        fixed_amount=Decimal("199.99"),
        fixed_currency="USD",
        discount_kind="percent",
        discount_value=Decimal("3.5"),
        valid_from=now() - timedelta(days=60),
        valid_to=now() + timedelta(days=365),
    )
    finance = make_user(Role.FINANCE, suffix="dash")

    rub = make_flight(organization, client_alpha, aircraft, "SLG-6001", "RUB", days=-1)
    complete(place(rub, fuel_service, vendor_alpha, dispatcher, "1000"), dispatcher, "1237.5")
    place(rub, handling, vendor_alpha, dispatcher, "1")
    cancelled = place(rub, fuel_service, vendor_alpha, dispatcher, "50")
    transitions.apply_transition(cancelled, "cancel", actor=dispatcher, comment="Не нужна")
    invoice = documents.build_invoice(flight=rub, quote=None, actor=finance)
    documents.issue_invoice(invoice=invoice, actor=finance)

    usd = make_flight(organization, client_beta, aircraft, "SLG-6002", "USD", days=-2)
    complete(place(usd, handling, vendor_alpha, dispatcher, "1"), dispatcher, "1")
    complete(place(usd, fuel_service, vendor_alpha, dispatcher, "333.3333"), dispatcher, "350")
    place(usd, fuel_service, vendor_alpha, dispatcher, "10")

    empty = make_flight(organization, client_alpha, aircraft, "SLG-6003", "EUR", days=-3)
    order_services.create_order(
        flight=empty,
        service=fuel_service,
        leg="departure",
        quantity=Decimal(5),
        vendor=None,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )
    return [rub, usd, empty]


# ─────────────────────────── ADR-012 ───────────────────────────


def test_aggregate_path_matches_the_canonical_margin_to_the_kopeck(
    varied_set: list[Flight],
) -> None:
    dashboards.refresh_views()
    with connection.cursor() as cursor:
        cursor.execute("SELECT flight_id, revenue, cost FROM reports_flight_margin")
        aggregated = {row[0]: (row[1], row[2]) for row in cursor.fetchall()}

    assert set(aggregated) == {flight.pk for flight in Flight.objects.all()}
    checked = 0
    for flight in Flight.objects.all():
        canonical = margin_service.margin_for(flight, "mixed")
        revenue, cost = aggregated[flight.pk]
        assert (revenue, cost) == (canonical.revenue.amount, canonical.cost.amount), flight.number
        checked += 1
    assert checked == 3
    # Набор не тривиален: у рублёвого и долларового рейса есть деньги.
    assert all(aggregated[flight.pk][0] > 0 for flight in varied_set[:2])


def test_views_hold_only_numeric_money_columns() -> None:
    """`CLAUDE.md § 3` п. 1: ни одного double precision в денежных агрегатах."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) "
            "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
            "WHERE c.relname IN ('reports_order_margin', 'reports_flight_margin') "
            "AND a.attnum > 0 AND a.attname IN ('sale', 'cost', 'revenue')"
        )
        types = {(row[0], row[1]): row[2] for row in cursor.fetchall()}
    assert types
    assert all(value == "numeric" for value in types.values()), types


# ─────────────────────────── Диспетчер ───────────────────────────


def widgets_of(body: dict[str, Any]) -> dict[str, Any]:
    return {widget["code"]: widget["data"] for widget in body["widgets"]}


def test_dispatcher_dashboard_shows_the_current_situation(
    as_role: Callable[..., APIClient],
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    soon = make_flight(organization, client_alpha, aircraft, "SLG-6101", "RUB", days=0.05)
    late = place(soon, fuel_service, vendor_alpha, dispatcher)
    ServiceOrder.objects.filter(pk=late.pk).update(
        sla_breached=True, sla_confirm_deadline=now() - timedelta(hours=1)
    )
    aircraft.status = AircraftStatus.AOG
    aircraft.notes = "Отказ ВСУ"
    aircraft.save()

    body = as_role(Role.DISPATCHER).get("/api/v1/dashboards/dispatcher").json()
    data = widgets_of(body)

    assert set(data) == {item.code for item in dashboards.DISPATCHER_WIDGETS}
    assert data["upcoming"]["items"][0]["number"] == "SLG-6101"
    assert data["unconfirmed"]["count"] == 1
    assert data["sla_breaches"]["count"] == 1
    assert data["aircraft_out_of_service"]["items"][0]["registration"] == aircraft.registration
    # Рейс на неисправном борту — конфликт расписания.
    assert any(item["kind"] == "aircraft_unserviceable" for item in data["conflicts"]["items"])
    # До вылета меньше лидтайма топлива (4 ч), а поставщик не подтвердил.
    assert data["lead_time_overdue"]["count"] == 1
    assert body["layout"] == {"widgets": dashboards.default_layout("dispatcher")}
    assert body["generatedAt"] is not None


def test_finance_has_no_dispatcher_dashboard(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.FINANCE).get("/api/v1/dashboards/dispatcher")
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_dispatcher_has_no_manager_dashboard(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.DISPATCHER).get("/api/v1/dashboards/manager")
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_unknown_dashboard_is_not_found(as_role: Callable[..., APIClient]) -> None:
    assert as_role(Role.MANAGER).get("/api/v1/dashboards/pilot").status_code == (
        status.HTTP_404_NOT_FOUND
    )


# ─────────────────────────── Руководитель ───────────────────────────


def test_manager_dashboard_reads_the_refreshed_aggregates(
    as_role: Callable[..., APIClient], varied_set: list[Flight]
) -> None:
    stamp = dashboards.refresh_views()

    body = as_role(Role.MANAGER).get("/api/v1/dashboards/manager").json()
    data = widgets_of(body)

    assert body["generatedAt"] == stamp.isoformat()
    expected = sum(
        (
            fx.convert(
                margin_service.margin_for(flight, "mixed").revenue, "RUB", RATES
            )
            for flight in varied_set
        ),
        Money.zero("RUB"),
    ).rounded()
    assert data["margin_summary"]["revenue"] == expected.to_json()
    assert data["margin_summary"]["currency"] == "RUB"
    by_revenue = data["top_clients"]["byRevenue"]
    assert {item["name"] for item in by_revenue} >= {"Авиалинии Северного Ветра"}
    categories = {item["category"] for item in data["category_margin"]["items"]}
    assert categories == {"fuel", "handling"}
    assert data["fleet_usage"] == {"used": 1, "total": 1}
    assert data["margin_health"]["total"] == 2
    # Выставленный неоплаченный счёт — в дебиторке.
    receivables = {item["bucket"]: item["amount"] for item in data["receivables"]["items"]}
    assert Decimal(receivables["0–30"]["amount"]) > 0


# ─────────────────────────── Раскладка ───────────────────────────


def test_layout_is_saved_per_user(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.MANAGER)
    layout = {
        "widgets": [
            {"code": "margin_summary", "x": 0, "y": 0, "w": 12, "h": 3},
            {"code": "top_clients", "x": 0, "y": 3, "w": 6, "h": 4},
        ]
    }

    saved = api.put("/api/v1/dashboards/manager/layout", layout, format="json")
    assert saved.status_code == status.HTTP_200_OK, saved.json()

    body = api.get("/api/v1/dashboards/manager").json()
    assert body["layout"] == layout
    # Убранные виджеты всё равно отдаются: из них виджет добавляют обратно.
    assert len(body["widgets"]) == len(dashboards.MANAGER_WIDGETS)


@pytest.mark.parametrize(
    "widgets",
    [
        [{"code": "conflicts", "x": 0, "y": 0, "w": 4, "h": 2}],
        [{"code": "top_clients", "x": 8, "y": 0, "w": 6, "h": 2}],
        [
            {"code": "top_clients", "x": 0, "y": 0, "w": 4, "h": 2},
            {"code": "top_clients", "x": 4, "y": 0, "w": 4, "h": 2},
        ],
    ],
)
def test_impossible_layout_is_refused(
    as_role: Callable[..., APIClient], widgets: list[dict[str, Any]]
) -> None:
    response = as_role(Role.MANAGER).put(
        "/api/v1/dashboards/manager/layout", {"widgets": widgets}, format="json"
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
