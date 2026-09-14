"""Цены поставщиков и добавление аэропорта `[ТЗ 3.2.1]`.

Главное, что проверяется: периоды действия цены не накладываются друг
на друга. Наложение означает, что на дату оказания подходят две цены,
и выбор между ними произволен — а это разные суммы в счёте.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from catalog import services as catalog_services
from catalog.models import Airport, Service, ServiceCategory, ServiceUnit
from core.clock import now
from core.money import Money

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Vendor

pytestmark = pytest.mark.django_db

PRICES_URL = "/api/v1/catalog/prices"
AIRPORTS_URL = "/api/v1/airports"


def idempotent(key: str = "price-key-000001") -> dict[str, str]:
    """Заголовок идемпотентности (ADR-018)."""
    return {"Idempotency-Key": key}


@pytest.fixture
def airport_ulli(db: None) -> Airport:
    return Airport.objects.create(
        icao="ULLI",
        iata="LED",
        name_ru="Пулково",
        name_en="Pulkovo",
        city_ru="Санкт-Петербург",
        city_en="Saint Petersburg",
        country="RU",
        timezone="Europe/Moscow",
        lat=59.8003,
        lon=30.2625,
        elevation_ft=78,
    )


@pytest.fixture
def service_fuel(db: None) -> Service:
    return Service.objects.create(
        code="FUEL-JETA1",
        category=ServiceCategory.FUEL,
        name_ru="Заправка Jet A-1",
        name_en="Jet A-1 refuelling",
        unit=ServiceUnit.LITRE,
        lead_time_h=4,
    )


def price_payload(vendor: Vendor, service: Service, **overrides: Any) -> dict[str, Any]:
    start = now()
    payload: dict[str, Any] = {
        "vendorId": vendor.pk,
        "serviceId": service.pk,
        "airportIcao": "ulli",
        "price": {"amount": "72.4000", "currency": "RUB"},
        "validFrom": start.isoformat(),
        "validTo": (start + timedelta(days=90)).isoformat(),
        "surcharges": [{"code": "night", "kind": "percent", "value": "15.0000"}],
    }
    payload.update(overrides)
    return payload


def test_price_is_created_and_listed(
    as_role: Callable[..., APIClient],
    vendor_alpha: Vendor,
    service_fuel: Service,
    airport_ulli: Airport,
) -> None:
    api = as_role(Role.FINANCE)
    created = api.post(
        PRICES_URL, price_payload(vendor_alpha, service_fuel), format="json", headers=idempotent()
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    # Код аэропорта нормализован: подбор ищет по точному коду
    assert body["airportIcao"] == "ULLI"
    assert body["price"] == {"amount": "72.4000", "currency": "RUB"}
    assert body["vendorName"] == vendor_alpha.name
    assert body["surcharges"][0]["code"] == "night"

    listed = api.get(f"{PRICES_URL}?airportIcao=ULLI")
    assert len(listed.json()["data"]) == 1


def test_overlapping_period_for_same_triple_is_rejected(
    as_role: Callable[..., APIClient],
    vendor_alpha: Vendor,
    service_fuel: Service,
    airport_ulli: Airport,
) -> None:
    """Две цены на одну дату — это две разные суммы в счёте."""
    api = as_role(Role.FINANCE)
    api.post(
        PRICES_URL,
        price_payload(vendor_alpha, service_fuel),
        format="json",
        headers=idempotent("price-a-000001"),
    )

    start = now() + timedelta(days=30)
    clashing = api.post(
        PRICES_URL,
        price_payload(
            vendor_alpha,
            service_fuel,
            validFrom=start.isoformat(),
            validTo=(start + timedelta(days=90)).isoformat(),
        ),
        format="json",
        headers=idempotent("price-b-000002"),
    )
    assert clashing.status_code == status.HTTP_400_BAD_REQUEST
    assert "пересекается" in str(clashing.json()["error"]["details"])


def test_adjacent_period_is_allowed(
    as_role: Callable[..., APIClient],
    vendor_alpha: Vendor,
    service_fuel: Service,
    airport_ulli: Airport,
) -> None:
    """Смена прайса с определённой даты — не пересечение, а штатный случай."""
    api = as_role(Role.FINANCE)
    start = now()
    api.post(
        PRICES_URL,
        price_payload(
            vendor_alpha,
            service_fuel,
            validFrom=start.isoformat(),
            validTo=(start + timedelta(days=30)).isoformat(),
        ),
        format="json",
        headers=idempotent("price-c-000001"),
    )
    following = api.post(
        PRICES_URL,
        price_payload(
            vendor_alpha,
            service_fuel,
            validFrom=(start + timedelta(days=30)).isoformat(),
            validTo=(start + timedelta(days=60)).isoformat(),
        ),
        format="json",
        headers=idempotent("price-d-000002"),
    )
    assert following.status_code == status.HTTP_201_CREATED, following.data


def test_effective_price_is_taken_for_service_date_not_today(
    vendor_alpha: Vendor, service_fuel: Service, airport_ulli: Airport, dispatcher: Any
) -> None:
    """Заказ на послезавтра считается по цене, действующей послезавтра."""
    start = now()
    catalog_services.create_price(
        vendor_id=vendor_alpha.pk,
        service_id=service_fuel.pk,
        airport_icao="ULLI",
        amount=Decimal("70.0000"),
        currency="RUB",
        min_charge_amount=None,
        valid_from=start,
        valid_to=start + timedelta(days=10),
        surcharges=[],
        actor=dispatcher,
    )
    catalog_services.create_price(
        vendor_id=vendor_alpha.pk,
        service_id=service_fuel.pk,
        airport_icao="ULLI",
        amount=Decimal("81.5000"),
        currency="RUB",
        min_charge_amount=None,
        valid_from=start + timedelta(days=10),
        valid_to=start + timedelta(days=40),
        surcharges=[],
        actor=dispatcher,
    )

    today = catalog_services.effective_price(
        vendor_id=vendor_alpha.pk,
        service_id=service_fuel.pk,
        airport_icao="ULLI",
        moment=start + timedelta(days=1),
    )
    later = catalog_services.effective_price(
        vendor_id=vendor_alpha.pk,
        service_id=service_fuel.pk,
        airport_icao="ULLI",
        moment=start + timedelta(days=20),
    )
    assert today is not None and today.amount == Decimal("70.0000")
    assert later is not None and later.amount == Decimal("81.5000")


def test_min_charge_in_other_currency_is_rejected(
    as_role: Callable[..., APIClient],
    vendor_alpha: Vendor,
    service_fuel: Service,
    airport_ulli: Airport,
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        PRICES_URL,
        price_payload(
            vendor_alpha,
            service_fuel,
            minCharge={"amount": "100.0000", "currency": "USD"},
        ),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_client_portal_cannot_read_purchase_prices(
    as_role: Callable[..., APIClient], client_alpha: Any
) -> None:
    """Закупочная цена — не для клиента: он видит цену продажи (`SPEC.md § 2.2`)."""
    api = as_role(Role.CLIENT, client=client_alpha)
    assert api.get(PRICES_URL).status_code == status.HTTP_403_FORBIDDEN


# ─────────────────────── Формула закупочной стоимости ───────────────────────


def test_purchase_cost_applies_percent_surcharge_to_base() -> None:
    """`DOMAIN.md § 7.1`: надбавка в процентах считается от базы, не нарастающим итогом."""
    cost = catalog_services.purchase_cost(
        unit_amount=Decimal("100.0000"),
        currency="RUB",
        quantity=Decimal("10"),
        surcharges=[
            {"code": "night", "kind": "percent", "value": "10"},
            {"code": "urgent", "kind": "percent", "value": "5"},
        ],
        min_charge_amount=None,
    )
    # 1000 + 100 + 50, а не 1000 × 1.10 × 1.05
    assert cost == Money.of("1150.00", "RUB")


def test_purchase_cost_respects_min_charge() -> None:
    cost = catalog_services.purchase_cost(
        unit_amount=Decimal("10.0000"),
        currency="RUB",
        quantity=Decimal("2"),
        surcharges=[],
        min_charge_amount=Decimal("500.0000"),
    )
    assert cost == Money.of("500.00", "RUB")


def test_purchase_cost_rounds_once_on_total() -> None:
    """ADR-002: округление одно, на итоге, а не на каждом слагаемом."""
    cost = catalog_services.purchase_cost(
        unit_amount=Decimal("33.3333"),
        currency="RUB",
        quantity=Decimal("3"),
        surcharges=[{"code": "weekend", "kind": "fixed", "value": "0.005"}],
        min_charge_amount=None,
    )
    # 99.9999 + 0.005 = 100.0049 → 100.00
    assert cost.to_display() == "100.00"


# ─────────────────────────── Аэропорты ───────────────────────────


def airport_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "icao": "uwkd",
        "iata": "kzn",
        "name": {"ru": "Казань", "en": "Kazan"},
        "city": {"ru": "Казань", "en": "Kazan"},
        "country": "ru",
        "timezone": "Europe/Moscow",
        "lat": 55.6062,
        "lon": 49.2787,
        "elevationFt": 411,
    }
    payload.update(overrides)
    return payload


def test_airport_is_added_and_codes_normalised(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.FINANCE)
    created = api.post(AIRPORTS_URL, airport_payload(), format="json", headers=idempotent())

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    assert body["icao"] == "UWKD"
    assert body["iata"] == "KZN"
    assert body["country"] == "RU"
    assert body["name"] == {"ru": "Казань", "en": "Kazan"}


def test_unknown_timezone_is_rejected(as_role: Callable[..., APIClient]) -> None:
    """Ошибка в зоне всплывает на рейсе, а не при вводе, — ловим при вводе."""
    api = as_role(Role.FINANCE)
    response = api.post(
        AIRPORTS_URL,
        airport_payload(timezone="Europe/Kazan-Oblast"),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_duplicate_icao_is_rejected(
    as_role: Callable[..., APIClient], airport_ulli: Airport
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        AIRPORTS_URL, airport_payload(icao="ULLI"), format="json", headers=idempotent()
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_dispatcher_cannot_add_airport(as_role: Callable[..., APIClient]) -> None:
    """Ошибка в координатах разошлась бы по всем рейсам через эту площадку."""
    api = as_role(Role.DISPATCHER)
    response = api.post(AIRPORTS_URL, airport_payload(), format="json", headers=idempotent())
    assert response.status_code == status.HTTP_403_FORBIDDEN
