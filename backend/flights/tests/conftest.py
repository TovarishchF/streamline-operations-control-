"""Приспособления для тестов рейсов."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import pytest

from accounts.models import Role
from catalog.models import AircraftType, Airport, Service, ServiceCategory
from core import clock
from core.models import DataSource
from fleet.models import Aircraft
from flights.models import Flight, ServiceLeg
from flights.services import planning, transitions
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import User
    from counterparties.models import Client


@pytest.fixture
def airports(db: None) -> dict[str, Airport]:
    """Настоящие коды и координаты: справочные данные не выдумываются."""
    data = [
        ("UUWW", "Внуково", "RU", "Europe/Moscow", 55.591531, 37.261486, False),
        ("ULLI", "Пулково", "RU", "Europe/Moscow", 59.800292, 30.262503, False),
        ("UUEE", "Шереметьево", "RU", "Europe/Moscow", 55.972642, 37.414589, True),
        ("LFPB", "Le Bourget", "FR", "Europe/Paris", 48.969398, 2.441390, False),
        ("UNNT", "Толмачёво", "RU", "Asia/Novosibirsk", 55.012622, 82.650656, False),
    ]
    created = {}
    for icao, name, country, zone, lat, lon, coordinated in data:
        created[icao] = Airport.objects.create(
            icao=icao, name_ru=name, name_en=name, city_ru="", city_en="",
            country=country, timezone=zone, lat=lat, lon=lon,
            is_coordinated=coordinated, data_source=DataSource.IMPORTED,
        )
    return created


@pytest.fixture
def aircraft_type(db: None) -> AircraftType:
    return AircraftType.objects.create(
        icao_type="CL60", name_ru="Challenger 605", name_en="Challenger 605",
        category="heavy", seats=12, cruise_speed_kts=459,
        fuel_burn_kg_per_hour=700, turnaround_min=75, data_source=DataSource.IMPORTED,
    )


@pytest.fixture
def aircraft(aircraft_type: AircraftType, client_alpha: Client) -> Aircraft:
    return Aircraft.objects.create(
        registration="RA-67231", type=aircraft_type, operator=client_alpha,
        home_base_icao="UUWW",
    )


@pytest.fixture
def dispatcher(make_user: Callable[..., User]) -> User:
    return make_user(Role.DISPATCHER)


@pytest.fixture
def flight(airports: dict[str, Airport], client_alpha: Client) -> Flight:
    return planning.create_flight(
        client=client_alpha,
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=clock.now() + timedelta(hours=6),
    )


@pytest.fixture
def flight_with_aircraft(flight: Flight, aircraft: Aircraft) -> Flight:
    return planning.update_route(flight, aircraft=aircraft)


@pytest.fixture
def flight_in_work(flight_with_aircraft: Flight, dispatcher: User) -> Flight:
    service, _ = Service.objects.get_or_create(
        code="HND_BASIC",
        defaults={
            "category": ServiceCategory.HANDLING,
            "name_ru": "Базовое обслуживание", "name_en": "Basic handling", "unit": "flight",
        },
    )
    ServiceOrder.objects.create(
        flight=flight_with_aircraft, service=service, leg=ServiceLeg.DEPARTURE,
        airport_icao=flight_with_aircraft.dep_icao,
    )
    return transitions.apply_transition(flight_with_aircraft, "start", actor=dispatcher)


@pytest.fixture
def flight_ready(flight_in_work: Flight, dispatcher: User) -> Flight:
    flight_in_work.service_orders.update(status=ServiceOrderStatus.CONFIRMED)
    return transitions.apply_transition(flight_in_work, "ready", actor=dispatcher)
