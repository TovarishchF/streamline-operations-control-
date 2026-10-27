"""Подбор поставщика `[ТЗ 3.3.2]` (`DOMAIN.md § 7.5`).

Приёмка M6: смена режима подбора предсказуемо меняет порядок кандидатов,
состав баллов виден.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import TariffMode, TariffRule
from core.clock import now
from counterparties.services import suggest
from counterparties.tests.conftest import give_contract, give_price, make_vendor
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import Organization
    from catalog.models import Service
    from counterparties.models import Client, Vendor
    from flights.models import Flight

pytestmark = pytest.mark.django_db

QUANTITY = Decimal(1000)


def names(candidates: list[suggest.Candidate]) -> list[str]:
    return [candidate.vendor.name for candidate in candidates]


def run(service: Service, mode: str, **extra: object) -> list[suggest.Candidate]:
    return suggest.suggest(
        service=service,
        airport_icao="UUWW",
        moment=now() + timedelta(days=2),
        quantity=QUANTITY,
        mode=mode,
        **extra,  # type: ignore[arg-type]  # именованные аргументы сценария
    )


def rate(vendor: Vendor, flight: Flight, service: Service) -> None:
    """Пять подтверждений в срок — у поставщика появляется рейтинг."""
    for _ in range(5):
        created = ServiceOrder.objects.create(
            flight=flight,
            service=service,
            leg="departure",
            airport_icao="UUWW",
            vendor=vendor,
            quantity=Decimal(1),
            ordered_at=now() - timedelta(days=3),
            sla_confirm_deadline=now() - timedelta(days=3) + timedelta(hours=2),
            confirmed_at=now() - timedelta(days=3) + timedelta(hours=1),
        )
        ServiceOrder.objects.filter(pk=created.pk).update(status=ServiceOrderStatus.CONFIRMED)


def test_price_mode_puts_the_cheapest_first(
    fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    candidates = run(fuel_service, "price")

    assert names(candidates) == ["Топливо Эконом", "Домодедово Ойл", "Внуково Фьюэл"]
    assert [c.price_score for c in candidates] == [Decimal(1), Decimal("0.5000"), Decimal("0.0000")]
    assert candidates[0].cost.to_json() == {"amount": "60000.0000", "currency": "RUB"}


def test_proximity_mode_prefers_a_base_at_the_airport(
    fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    candidates = run(fuel_service, "proximity")

    assert names(candidates) == ["Внуково Фьюэл", "Домодедово Ойл", "Топливо Эконом"]
    local, near, cheap = candidates
    assert (local.has_base, local.proximity_score) == (True, Decimal(1))
    # Домодедово — около 45 км от Внукова: 1 − 45/200.
    assert near.distance_km is not None
    assert Decimal(40) < near.distance_km < Decimal(50)
    assert Decimal("0.75") < near.proximity_score < Decimal("0.80")
    # Без баз расстояние не выдумывается.
    assert (cheap.distance_km, cheap.proximity_score) == (None, Decimal(0))


def test_rating_mode_follows_the_rating(
    flight: Flight, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    rate(fuel_vendors["local"], flight, fuel_service)

    candidates = run(fuel_service, "rating")

    assert names(candidates)[0] == "Внуково Фьюэл"
    assert candidates[0].rating_score > Decimal(0)
    # Без рейтинга балл нулевой, порядок среди равных — по цене.
    assert names(candidates)[1:] == ["Топливо Эконом", "Домодедово Ойл"]


def test_balanced_mode_uses_weights_from_settings(
    fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    candidates = run(fuel_service, "balanced")

    for candidate in candidates:
        expected = (
            Decimal("0.50") * candidate.price_score
            + Decimal("0.30") * candidate.rating_score
            + Decimal("0.20") * candidate.proximity_score
        ).quantize(Decimal("0.0001"))
        assert candidate.total_score == expected


def test_custom_weights_are_applied(fuel_service: Service, fuel_vendors: dict[str, Vendor]) -> None:
    candidates = run(
        fuel_service, "custom", custom_weights={"price": "0", "rating": "0", "proximity": "1"}
    )
    assert names(candidates)[0] == "Внуково Фьюэл"


def test_only_vendors_passing_the_order_checks_are_candidates(
    organization: Organization, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    wrong_category = make_vendor(
        organization, "Кейтеринг Плюс", specializations=["catering"], bases=[]
    )
    give_contract(wrong_category)
    give_price(wrong_category, fuel_service, "10")

    expired = make_vendor(organization, "Старый Партнёр", specializations=["fuel"], bases=["UUWW"])
    give_contract(expired, days_left=1)
    give_price(expired, fuel_service, "10")

    assert "Кейтеринг Плюс" not in names(run(fuel_service, "price"))
    assert "Старый Партнёр" not in names(run(fuel_service, "price"))


# ─────────────────────────── Влияние на маржу ───────────────────────────


def tariff(client: Client, mode: str, **values: object) -> None:
    TariffRule.objects.create(
        client=client,
        mode=mode,
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=365),
        **values,
    )


def test_margin_impact_follows_the_clients_tariff(
    flight: Flight, client_alpha: Client, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    """При «закупке плюс наценка» дешёвый поставщик даёт меньший вклад в маржу."""
    tariff(client_alpha, TariffMode.COST_PLUS, markup_percent=Decimal(10))

    impact = {c.vendor.name: c.margin_impact for c in run(fuel_service, "price", flight=flight)}

    assert impact["Топливо Эконом"] is not None
    assert impact["Топливо Эконом"].to_json() == {"amount": "6000.0000", "currency": "RUB"}
    assert impact["Внуково Фьюэл"] is not None
    assert impact["Внуково Фьюэл"].to_json() == {"amount": "8000.0000", "currency": "RUB"}


def test_margin_impact_is_relative_to_the_current_order(
    flight: Flight, client_alpha: Client, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    """Фиксированная цена 90 за литр: замена дорогого на дешёвого даёт +20 000."""
    tariff(client_alpha, TariffMode.FIXED, fixed_amount=Decimal(90), fixed_currency="RUB")
    current = ServiceOrder.objects.create(
        flight=flight,
        service=fuel_service,
        leg="departure",
        airport_icao="UUWW",
        vendor=fuel_vendors["local"],
        quantity=QUANTITY,
        purchase_unit_amount=Decimal(80),
        purchase_currency="RUB",
        purchase_cost_amount=Decimal(80000),
    )
    ServiceOrder.objects.filter(pk=current.pk).update(status=ServiceOrderStatus.ORDERED)

    impact = {c.vendor.name: c.margin_impact for c in run(fuel_service, "price", flight=flight)}

    assert impact["Топливо Эконом"] is not None
    assert impact["Топливо Эконом"].to_json() == {"amount": "20000.0000", "currency": "RUB"}
    assert impact["Внуково Фьюэл"] is not None
    assert impact["Внуково Фьюэл"].is_zero


def test_without_flight_impact_is_not_computed(
    fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    assert all(candidate.margin_impact is None for candidate in run(fuel_service, "price"))


# ─────────────────────────── API ───────────────────────────


def test_suggest_endpoint_returns_the_comparison_table(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    fuel_vendors: dict[str, Vendor],
) -> None:
    response = as_role(Role.DISPATCHER).post(
        "/api/v1/vendors/suggest",
        {
            "serviceId": fuel_service.pk,
            "airportIcao": "UUWW",
            "onDate": (now() + timedelta(days=2)).isoformat(),
            "quantity": "1000",
            "flightId": flight.pk,
            "mode": "price",
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.json()
    first = response.json()["data"][0]
    assert first["vendorName"] == "Топливо Эконом"
    assert set(first) == {
        "vendorId",
        "vendorName",
        "cost",
        "priceScore",
        "ratingScore",
        "proximityScore",
        "totalScore",
        "distanceKm",
        "hasBaseAtAirport",
        "marginImpact",
    }
    assert first["priceScore"] == "1.0000"
    assert first["totalScore"] == "1.0000"


def test_custom_mode_without_weights_is_refused(
    as_role: Callable[..., APIClient], fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    response = as_role(Role.DISPATCHER).post(
        "/api/v1/vendors/suggest",
        {
            "serviceId": fuel_service.pk,
            "airportIcao": "UUWW",
            "onDate": (now() + timedelta(days=2)).isoformat(),
            "mode": "custom",
        },
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_portal_roles_cannot_suggest(
    as_role: Callable[..., APIClient], fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    response = as_role(Role.VENDOR, vendor=fuel_vendors["cheap"]).post(
        "/api/v1/vendors/suggest",
        {
            "serviceId": fuel_service.pk,
            "airportIcao": "UUWW",
            "onDate": (now() + timedelta(days=2)).isoformat(),
        },
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN
