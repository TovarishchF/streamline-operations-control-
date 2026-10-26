"""Приспособления для тестов рейтинга, подбора поставщика и сроков договоров.

Три поставщика топлива во Внукове с разными свойствами: дешёвый без базы,
дорогой с базой в аэропорту и средний с базой в Домодедове. Подбор должен
расставить их по-разному в зависимости от режима — это и проверяется.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

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
from counterparties.models import PaymentMode, Vendor, VendorContract
from fleet.models import Aircraft
from flights.models import Flight

if TYPE_CHECKING:
    from accounts.models import Organization
    from counterparties.models import Client


@pytest.fixture
def airports(db: None) -> dict[str, Airport]:
    rows = (
        ("UUWW", "VKO", "Внуково", "Vnukovo", 55.5915, 37.2615),
        ("UUDD", "DME", "Домодедово", "Domodedovo", 55.4088, 37.9063),
        ("ULLI", "LED", "Пулково", "Pulkovo", 59.8003, 30.2625),
    )
    return {
        icao: Airport.objects.create(
            icao=icao,
            iata=iata,
            name_ru=name_ru,
            name_en=name_en,
            country="RU",
            timezone="Europe/Moscow",
            lat=lat,
            lon=lon,
        )
        for icao, iata, name_ru, name_en, lat, lon in rows
    }


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
def flight(
    organization: Organization, client_alpha: Client, airports: dict[str, Airport]
) -> Flight:
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
    aircraft = Aircraft.objects.create(
        registration="RA-10500", type=aircraft_type, home_base_icao="UUWW"
    )
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number="SLG-9100",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=6,
        billing_currency="RUB",
    )


def make_vendor(
    organization: Organization,
    name: str,
    *,
    specializations: list[str],
    bases: list[str],
    quality: int = 3,
) -> Vendor:
    return Vendor.objects.create(
        organization=organization,
        name=name,
        specializations=specializations,
        coverage_airports=bases,
        manual_quality_score=quality,
    )


def give_contract(vendor: Vendor, *, days_left: int = 270) -> VendorContract:
    return VendorContract.objects.create(
        vendor=vendor,
        number=f"ДГ-{vendor.name[:6]}",
        valid_from=now() - timedelta(days=90),
        valid_to=now() + timedelta(days=days_left),
        currency="RUB",
        payment_mode=PaymentMode.DEFERRED,
        payment_defer_days=14,
    )


def give_price(vendor: Vendor, service: Service, amount: str, *, airport: str = "UUWW") -> None:
    VendorPrice.objects.create(
        vendor=vendor,
        service=service,
        airport_icao=airport,
        amount=Decimal(amount),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
        surcharges=[],
    )


@pytest.fixture
def fuel_vendors(
    organization: Organization, fuel_service: Service, airports: dict[str, Airport]
) -> dict[str, Vendor]:
    """Дешёвый без базы, дорогой с базой во Внукове, средний с базой в Домодедове."""
    vendors = {
        "cheap": make_vendor(organization, "Топливо Эконом", specializations=["fuel"], bases=[]),
        "local": make_vendor(
            organization, "Внуково Фьюэл", specializations=["fuel"], bases=["UUWW"]
        ),
        "near": make_vendor(
            organization, "Домодедово Ойл", specializations=["fuel", "handling"], bases=["UUDD"]
        ),
    }
    for key, amount in (("cheap", "60"), ("local", "80"), ("near", "70")):
        give_contract(vendors[key])
        give_price(vendors[key], fuel_service, amount)
    return vendors
