"""Приспособления для тестов порталов.

Два клиента с рейсами и поставщик с ценой: изоляция проверяется
на соседстве чужих данных, а не на пустой базе.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest

from catalog.models import Airport, Service, ServiceCategory, ServiceUnit, VendorPrice
from core.clock import now
from counterparties.models import PaymentMode, VendorContract
from flights.models import Flight

if TYPE_CHECKING:
    from accounts.models import Organization
    from counterparties.models import Client, Vendor


@pytest.fixture
def airports(db: None) -> None:
    for icao, iata, name, lat, lon in (
        ("UUWW", "VKO", "Внуково", 55.5915, 37.2615),
        ("ULLI", "LED", "Пулково", 59.8003, 30.2625),
    ):
        Airport.objects.create(
            icao=icao,
            iata=iata,
            name_ru=name,
            name_en=name,
            country="RU",
            timezone="Europe/Moscow",
            lat=lat,
            lon=lon,
        )


def make_flight(organization: Organization, client: Client, number: str) -> Flight:
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number=number,
        client=client,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=4,
        billing_currency="RUB",
    )


@pytest.fixture
def own_flight(organization: Organization, client_alpha: Client, airports: None) -> Flight:
    return make_flight(organization, client_alpha, "SLG-5001")


@pytest.fixture
def foreign_flight(organization: Organization, client_beta: Client, airports: None) -> Flight:
    return make_flight(organization, client_beta, "SLG-5002")


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
def priced_vendor(vendor_alpha: Vendor, fuel_service: Service, airports: None) -> Vendor:
    VendorContract.objects.create(
        vendor=vendor_alpha,
        number="ДГ-2026-5001",
        valid_from=now() - timedelta(days=90),
        valid_to=now() + timedelta(days=270),
        currency="RUB",
        payment_mode=PaymentMode.DEFERRED,
        payment_defer_days=14,
    )
    VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=fuel_service,
        airport_icao="UUWW",
        amount=Decimal("70.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
    )
    return vendor_alpha
