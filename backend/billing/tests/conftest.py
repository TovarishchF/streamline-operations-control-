"""Приспособления для тестов биллинга.

Те же, что у заявок: счёт строится из выполненных заявок, а заявка
не создаётся без рейса, услуги, договора и цены.

Собирают минимальный, но настоящий набор: рейс, услуга, поставщик
с действующим договором и ценой. Без любого из них заявку создать нельзя —
и это ровно то, что проверяют тесты проверок `SPEC.md § 5.2`.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest

from catalog.models import (
    AircraftCategory,
    AircraftType,
    Airport,
    Service,
    ServiceCategory,
    ServiceUnit,
    VendorPrice,
)
from core.clock import now
from counterparties.models import PaymentMode, VendorContract
from fleet.models import Aircraft
from flights.models import Flight

if TYPE_CHECKING:
    from accounts.models import Organization
    from counterparties.models import Client, Vendor


@pytest.fixture
def airport_departure(db: None) -> Airport:
    return Airport.objects.create(
        icao="UUWW",
        iata="VKO",
        name_ru="Внуково",
        name_en="Vnukovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.5915,
        lon=37.2615,
    )


@pytest.fixture
def airport_arrival(db: None) -> Airport:
    return Airport.objects.create(
        icao="ULLI",
        iata="LED",
        name_ru="Пулково",
        name_en="Pulkovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=59.8003,
        lon=30.2625,
    )


@pytest.fixture
def aircraft(db: None) -> Aircraft:
    aircraft_type = AircraftType.objects.create(
        icao_type="GLF5",
        name_ru="Gulfstream G550",
        name_en="Gulfstream G550",
        category=AircraftCategory.HEAVY,
        seats=16,
        cruise_speed_kts=488,
        fuel_burn_kg_per_hour=1300,
        turnaround_min=60,
    )
    return Aircraft.objects.create(
        registration="RA-10300", type=aircraft_type, home_base_icao="UUWW"
    )


@pytest.fixture
def flight(
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    airport_departure: Airport,
    airport_arrival: Airport,
) -> Flight:
    """Рейс через двое суток: лидтайм заведомо соблюдён."""
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number="SLG-9001",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=8,
        billing_currency="RUB",
    )


@pytest.fixture
def urgent_flight(
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    airport_departure: Airport,
    airport_arrival: Airport,
) -> Flight:
    """Рейс через час: лидтайм в четыре часа заведомо нарушен."""
    departure = now() + timedelta(hours=1)
    return Flight.objects.create(
        organization=organization,
        number="SLG-9002",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=4,
        billing_currency="RUB",
    )


@pytest.fixture
def fuel_service(db: None) -> Service:
    return Service.objects.create(
        code="FUEL-JETA1",
        category=ServiceCategory.FUEL,
        name_ru="Заправка Jet A-1",
        name_en="Jet A-1 refuelling",
        unit=ServiceUnit.LITRE,
        lead_time_h=4,
    )


@pytest.fixture
def handling_service_with_act(db: None) -> Service:
    """Услуга, для которой акт обязателен при переходе в «Выполнена»."""
    return Service.objects.create(
        code="HND-RAMP",
        category=ServiceCategory.HANDLING,
        name_ru="Перронное обслуживание",
        name_en="Ramp handling",
        unit=ServiceUnit.FLIGHT,
        lead_time_h=2,
        requires_act_to_complete=True,
    )


@pytest.fixture
def contract(vendor_alpha: Vendor) -> VendorContract:
    return VendorContract.objects.create(
        vendor=vendor_alpha,
        number="ДГ-2026-1001",
        valid_from=now() - timedelta(days=90),
        valid_to=now() + timedelta(days=270),
        currency="RUB",
        payment_mode=PaymentMode.DEFERRED,
        payment_defer_days=14,
    )


@pytest.fixture
def fuel_price(
    vendor_alpha: Vendor, fuel_service: Service, airport_departure: Airport
) -> VendorPrice:
    return VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=fuel_service,
        airport_icao="UUWW",
        amount=Decimal("70.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
        surcharges=[{"code": "night", "kind": "percent", "value": "10"}],
    )


@pytest.fixture
def order_payload() -> dict[str, Any]:
    return {"serviceId": "", "leg": "departure", "quantity": "1000.0000"}
