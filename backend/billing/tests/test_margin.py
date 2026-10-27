"""Маржа рейса `[ТЗ 3.4.3]` (`DOMAIN.md § 7.3`, ADR-012, ADR-023).

Приёмка M7:
* рейс в валюте, отличной от валюты поставщика, считает маржу корректно,
  курс зафиксирован в документе;
* расчёт маржи по рейсу с 30 услугами укладывается в норматив ТЗ 4.4 (5 с).
"""

from __future__ import annotations

import time
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import TariffMode, TariffRule
from billing.services import margin
from billing.tasks import check_margin
from comms.models import Notification
from core.clock import now
from core.money import Money
from flights.models import Flight
from orders.models import ServiceOrder
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import Organization, User
    from catalog.models import Service, VendorPrice
    from counterparties.models import Client, Vendor, VendorContract
    from fleet.models import Aircraft

pytestmark = pytest.mark.django_db

RUB = {"RUB": "1.0000", "USD": "90.0000", "EUR": "100.0000"}
THRESHOLD = Decimal(12)


def rub(amount: str) -> Money:
    return Money.of(amount, "RUB")


def item(
    status_value: str, plan: tuple[str, str] | None, fact: tuple[str, str] | None = None
) -> margin.Contribution:
    return margin.Contribution(
        status=status_value,
        plan_sale=rub(plan[0]) if plan else None,
        plan_cost=rub(plan[1]) if plan else None,
        fact_sale=rub(fact[0]) if fact else None,
        fact_cost=rub(fact[1]) if fact else None,
    )


# ─────────────────────────── Формула ───────────────────────────


def test_plan_takes_everything_but_cancelled_and_rejected() -> None:
    result = margin.compute(
        [
            item("ordered", ("1000", "800")),
            item("completed", ("500", "400"), ("600", "450")),
            item("cancelled", ("9999", "1")),
            item("rejected", ("9999", "1")),
        ],
        mode="plan",
        currency="RUB",
        rates=RUB,
        threshold=THRESHOLD,
    )

    assert result.revenue == rub("1500")
    assert result.cost == rub("1200")
    assert result.margin == rub("300")
    assert result.margin_percent == Decimal("20.00")
    assert result.plan_portion_percent is None


def test_fact_takes_only_completed_by_their_actuals() -> None:
    result = margin.compute(
        [item("ordered", ("1000", "800")), item("completed", ("500", "400"), ("600", "450"))],
        mode="fact",
        currency="RUB",
        rates=RUB,
        threshold=THRESHOLD,
    )

    assert (result.revenue, result.cost, result.margin) == (rub("600"), rub("450"), rub("150"))


def test_mixed_names_the_planned_share() -> None:
    result = margin.compute(
        [item("ordered", ("1000", "800")), item("completed", ("500", "400"), ("600", "450"))],
        mode="mixed",
        currency="RUB",
        rates=RUB,
        threshold=THRESHOLD,
    )

    assert result.revenue == rub("1600")
    assert result.cost == rub("1250")
    # 1000 из 1600 — плановая часть.
    assert result.plan_portion_percent == Decimal("62.50")


def test_negative_margin_is_shown_not_zeroed() -> None:
    result = margin.compute(
        [item("confirmed", ("700", "1000"))],
        mode="plan",
        currency="RUB",
        rates=RUB,
        threshold=THRESHOLD,
    )

    assert result.margin == rub("-300")
    assert result.margin_percent == Decimal("-42.86")
    assert result.is_below_threshold is True


def test_zero_revenue_gives_no_percent() -> None:
    result = margin.compute([], mode="plan", currency="RUB", rates=RUB, threshold=THRESHOLD)

    assert result.margin_percent is None
    assert result.is_below_threshold is False


def test_unpriced_draft_is_not_counted_as_zero() -> None:
    result = margin.compute(
        [item("draft", None), item("ordered", ("1000", "800"))],
        mode="plan",
        currency="RUB",
        rates=RUB,
        threshold=THRESHOLD,
    )
    assert result.revenue == rub("1000")


# ─────────────────────────── По данным рейса ───────────────────────────


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
        override_reason="",
        actor=actor,
    )


def complete(order: ServiceOrder, actor: User, actual: str) -> ServiceOrder:
    transitions.apply_transition(order, "confirm", actor=actor)
    transitions.apply_transition(order, "begin", actor=actor)
    started = now()
    order = order_services.update_order(
        order=order,
        changes={
            "actual_start_at": started,
            "actual_end_at": started + timedelta(minutes=30),
            "actual_quantity": Decimal(actual),
        },
        actor=actor,
    )
    transitions.apply_transition(order, "finish", actor=actor)
    return ServiceOrder.objects.get(pk=order.pk)


@pytest.fixture
def usd_flight(organization: Organization, client_alpha: Client, aircraft: Aircraft) -> Flight:
    """Рейс в долларах: курс зафиксирован в снимке рейса."""
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number="SLG-7001",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=4,
        billing_currency="USD",
        fx_snapshot={
            "date": departure.date().isoformat(),
            "base": "RUB",
            "rates": RUB,
            "policy": "document_date",
            "source": "live",
            "staleSince": None,
        },
    )


def test_flight_in_another_currency_than_the_vendor(
    as_role: Callable[..., APIClient],
    usd_flight: Flight,
    client_alpha: Client,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    """Приёмка M7. Закупка 77 000 ₽ = 855,56 $ по курсу рейса 90;
    продажа 855,5556 × 1,1 = 941,11 $; маржа 85,55 $ = 9,09 %."""
    TariffRule.objects.create(
        client=client_alpha,
        category="fuel",
        mode=TariffMode.COST_PLUS,
        markup_percent=Decimal(10),
        valid_from=now() - timedelta(days=10),
        valid_to=now() + timedelta(days=365),
    )
    place(usd_flight, fuel_service, vendor_alpha, dispatcher)

    response = as_role(Role.DISPATCHER).get(f"/api/v1/flights/{usd_flight.pk}/margin?mode=plan")

    assert response.status_code == status.HTTP_200_OK, response.json()
    body = response.json()
    assert body["currency"] == "USD"
    assert body["revenue"] == {"amount": "941.1100", "currency": "USD"}
    assert body["cost"] == {"amount": "855.5600", "currency": "USD"}
    assert body["margin"] == {"amount": "85.5500", "currency": "USD"}
    assert body["marginPercent"] == "9.09"
    assert body["isBelowThreshold"] is True
    # Курс показывается рядом с маржой — тот, что зафиксирован в рейсе.
    assert body["fx"]["rates"]["USD"] == "90.0000"


def test_fact_uses_the_actual_quantity_and_the_invoice(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    """Залили 1200 л вместо 1000: закупка 92 400, продажа ×1,15 = 106 260."""
    order = place(flight, fuel_service, vendor_alpha, dispatcher)
    order = complete(order, dispatcher, "1200")
    assert order.actual_cost_amount == Decimal("92400.0000")
    assert order.actual_sale_amount == Decimal("106260.0000")

    api = as_role(Role.FINANCE)
    fact = api.get(f"/api/v1/flights/{flight.pk}/margin?mode=fact").json()
    assert fact["revenue"]["amount"] == "106260.0000"
    assert fact["cost"]["amount"] == "92400.0000"

    # Выставленный счёт — источник факта (ADR-023).
    invoice = api.post(
        "/api/v1/invoices",
        {"flightId": flight.pk},
        format="json",
        headers={"Idempotency-Key": "margin-inv-01"},
    ).json()
    api.post(
        f"/api/v1/invoices/{invoice['id']}/issue",
        format="json",
        headers={"Idempotency-Key": "margin-inv-02"},
    )
    billed = api.get(f"/api/v1/flights/{flight.pk}/margin?mode=fact").json()
    assert billed["revenue"]["amount"] == invoice["totals"]["subtotal"]["amount"]


def test_cache_is_reset_when_orders_change(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    api = as_role(Role.DISPATCHER)
    url = f"/api/v1/flights/{flight.pk}/margin?mode=plan"
    assert api.get(url).json()["revenue"]["amount"] == "0.0000"

    place(flight, fuel_service, vendor_alpha, dispatcher)

    assert api.get(url).json()["revenue"]["amount"] == "88550.0000"


def test_unknown_mode_is_refused(as_role: Callable[..., APIClient], flight: Flight) -> None:
    response = as_role(Role.DISPATCHER).get(f"/api/v1/flights/{flight.pk}/margin?mode=guess")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_portal_roles_do_not_see_margin(
    as_role: Callable[..., APIClient], flight: Flight, client_alpha: Client
) -> None:
    response = as_role(Role.CLIENT, client=client_alpha).get(f"/api/v1/flights/{flight.pk}/margin")
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_schedule_shows_margin_to_staff_but_not_to_the_client(
    as_role: Callable[..., APIClient],
    make_user: Callable[..., User],
    api: APIClient,
    flight: Flight,
    client_alpha: Client,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    place(flight, fuel_service, vendor_alpha, dispatcher)

    staff_row = as_role(Role.DISPATCHER).get("/api/v1/flights").json()["data"][0]
    # 11 550 / 88 550 = 13,04 %
    assert staff_row["marginPercent"] == "13.04"

    api.force_authenticate(user=make_user(Role.CLIENT, suffix="portal", client=client_alpha))
    client_row = api.get("/api/v1/flights").json()["data"][0]
    assert client_row["marginPercent"] is None


def test_low_margin_notifies_once(
    flight: Flight,
    client_alpha: Client,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    """По себестоимости маржа ноль — ниже порога 12 %; уведомление одно."""
    TariffRule.objects.create(
        client=client_alpha,
        mode=TariffMode.PASS_THROUGH,
        valid_from=now() - timedelta(days=10),
        valid_to=now() + timedelta(days=365),
    )
    place(flight, fuel_service, vendor_alpha, dispatcher)

    assert check_margin(flight.pk) is True
    assert check_margin(flight.pk) is True
    assert Notification.objects.filter(user=dispatcher, kind="low_margin").count() == 1


def test_margin_of_thirty_services_is_within_the_norm(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    """ТЗ 4.4: расчёт маржи не дольше 5 секунд. Замер — без кэша."""
    for _ in range(30):
        place(flight, fuel_service, vendor_alpha, dispatcher, quantity="100")
    margin.invalidate(flight.pk)

    started = time.perf_counter()
    result = margin.margin_for(Flight.objects.get(pk=flight.pk), "mixed")
    elapsed = time.perf_counter() - started

    assert elapsed < 5
    assert result.revenue.amount > 0
