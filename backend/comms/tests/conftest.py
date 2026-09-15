"""Приспособления для тестов коммуникаций.

Минимальный набор: рейс с заявкой у поставщика — по нему собираются
и письма, и входящие. Заявка проводится сервисным слоем, а не прямой
записью: статус защищён автоматом (`CLAUDE.md § 3` п. 3).
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
from comms.models import MessageChannel, MessageTemplate, OutboxMessage, OutboxStatus
from core.clock import now
from counterparties.models import PaymentMode, VendorContract
from fleet.models import Aircraft
from flights.models import Flight
from orders.services import orders as order_services

if TYPE_CHECKING:
    from accounts.models import Organization, User
    from counterparties.models import Client, Vendor
    from orders.models import ServiceOrder


@pytest.fixture
def airports(db: None) -> tuple[Airport, Airport]:
    departure = Airport.objects.create(
        icao="UUWW",
        iata="VKO",
        name_ru="Внуково",
        name_en="Vnukovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.5915,
        lon=37.2615,
    )
    arrival = Airport.objects.create(
        icao="ULLI",
        iata="LED",
        name_ru="Пулково",
        name_en="Pulkovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=59.8003,
        lon=30.2625,
    )
    return departure, arrival


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
        registration="RA-10400", type=aircraft_type, home_base_icao="UUWW"
    )


@pytest.fixture
def flight(
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    airports: tuple[Airport, Airport],
) -> Flight:
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number="SLG-8001",
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
def contract(vendor_alpha: Vendor) -> VendorContract:
    return VendorContract.objects.create(
        vendor=vendor_alpha,
        number="ДГ-2026-8001",
        valid_from=now() - timedelta(days=90),
        valid_to=now() + timedelta(days=270),
        currency="RUB",
        payment_mode=PaymentMode.DEFERRED,
        payment_defer_days=14,
    )


@pytest.fixture
def fuel_price(
    vendor_alpha: Vendor, fuel_service: Service, airports: tuple[Airport, Airport]
) -> VendorPrice:
    return VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=fuel_service,
        airport_icao="UUWW",
        amount=Decimal("70.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
    )


@pytest.fixture
def order(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> ServiceOrder:
    """Заявка в статусе «Заказана»: ждёт ответа поставщика."""
    return order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal("1000.0000"),
        vendor=vendor_alpha,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )


@pytest.fixture
def template(db: None) -> MessageTemplate:
    return MessageTemplate.objects.create(
        code="order_placed",
        channel=MessageChannel.EMAIL,
        subject_ru="Заявка {{order.id}}: {{service.name}}",
        subject_en="Order {{order.id}}: {{service.name}}",
        body_ru="Рейс {{flight.number}} {{flight.route}}, вылет {{flight.std}} UTC.",
        body_en="Flight {{flight.number}} {{flight.route}}, departure {{flight.std}} UTC.",
        variables=["flight.number", "flight.route", "flight.std", "order.id", "service.name"],
    )


@pytest.fixture
def queued_message(db: None) -> OutboxMessage:
    return OutboxMessage.objects.create(
        channel=MessageChannel.EMAIL,
        to=[{"name": "Поставщик", "address": "ops@vendor.test", "locale": "ru"}],
        subject="Заявка на обслуживание",
        body="Текст заявки",
        status=OutboxStatus.QUEUED,
    )
