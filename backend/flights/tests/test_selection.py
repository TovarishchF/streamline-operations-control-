"""Отбор суточного плана `[ТЗ 3.1.1]` (`SPEC.md § 4.2`).

Фильтры таблицы: тип ВС, «есть неподтверждённые услуги», «маржа ниже N %»,
сортировка, несколько статусов. Выгрузка отбирает так же, как список.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from rest_framework import status

from accounts.models import Role
from catalog.models import Service, ServiceCategory, ServiceUnit
from core import clock
from flights.models import Flight
from flights.services import planning
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Airport
    from counterparties.models import Client
    from fleet.models import Aircraft

pytestmark = pytest.mark.django_db

URL = "/api/v1/flights"


@pytest.fixture
def three_flights(
    airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
) -> list[Flight]:
    base = clock.now() + timedelta(days=1)
    first = planning.create_flight(
        client=client_alpha, dep_icao="UUWW", arr_icao="ULLI", std_utc=base, aircraft=aircraft
    )
    second = planning.create_flight(
        client=client_alpha, dep_icao="ULLI", arr_icao="UUWW", std_utc=base + timedelta(hours=8)
    )
    third = planning.create_flight(
        client=client_alpha, dep_icao="UUWW", arr_icao="LFPB", std_utc=base + timedelta(hours=16)
    )
    service = Service.objects.create(
        code="HND-A",
        category=ServiceCategory.HANDLING,
        name_ru="Обслуживание",
        name_en="Handling",
        unit=ServiceUnit.FLIGHT,
    )
    ServiceOrder.objects.create(
        flight=second, service=service, leg="departure", airport_icao="ULLI", quantity=1
    )
    done = ServiceOrder.objects.create(
        flight=third, service=service, leg="departure", airport_icao="UUWW", quantity=1
    )
    ServiceOrder.objects.filter(pk=done.pk).update(status=ServiceOrderStatus.CONFIRMED)
    return [first, second, third]


def numbers(body: dict[str, list[dict[str, str]]]) -> list[str]:
    return [row["number"] for row in body["data"]]


def test_filter_by_aircraft_type(
    as_role: Callable[..., APIClient], three_flights: list[Flight], aircraft: Aircraft
) -> None:
    body = as_role(Role.DISPATCHER).get(URL, {"aircraftTypeId": aircraft.type_id}).json()
    assert numbers(body) == [three_flights[0].number]


def test_filter_by_unconfirmed_services(
    as_role: Callable[..., APIClient], three_flights: list[Flight]
) -> None:
    api = as_role(Role.DISPATCHER)
    assert numbers(api.get(URL, {"hasUnconfirmedServices": "true"}).json()) == [
        three_flights[1].number
    ]
    assert numbers(api.get(URL, {"hasUnconfirmedServices": "false"}).json()) == [
        three_flights[0].number,
        three_flights[2].number,
    ]


def test_ordering_by_column(as_role: Callable[..., APIClient], three_flights: list[Flight]) -> None:
    body = as_role(Role.DISPATCHER).get(URL, {"ordering": "-stdUtc"}).json()
    assert numbers(body) == [flight.number for flight in reversed(three_flights)]


def test_unknown_ordering_falls_back_to_departure(
    as_role: Callable[..., APIClient], three_flights: list[Flight]
) -> None:
    body = as_role(Role.DISPATCHER).get(URL, {"ordering": "password"}).json()
    assert numbers(body) == [flight.number for flight in three_flights]


def test_several_statuses_by_repeated_parameter(
    as_role: Callable[..., APIClient], three_flights: list[Flight]
) -> None:
    body = as_role(Role.DISPATCHER).get(f"{URL}?status=planned&status=cancelled").json()
    assert len(body["data"]) == 3


def test_margin_below_threshold(
    as_role: Callable[..., APIClient],
    three_flights: list[Flight],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from billing.services import margin

    percents = {
        three_flights[0].pk: "5.00",
        three_flights[1].pk: "20.00",
        three_flights[2].pk: None,
    }
    monkeypatch.setattr(
        margin,
        "percents_for",
        lambda flights: {flight.pk: percents[flight.pk] for flight in flights},
    )

    body = as_role(Role.DISPATCHER).get(URL, {"marginBelowPercent": "12"}).json()

    # Рейс без маржи в отбор «ниже порога» не попадает: о нём это не известно.
    assert numbers(body) == [three_flights[0].number]
    assert Decimal(body["data"][0]["marginPercent"]) == Decimal("5.00")


def test_margin_filter_is_closed_to_the_client(
    as_role: Callable[..., APIClient], three_flights: list[Flight], client_alpha: Client
) -> None:
    response = as_role(Role.CLIENT, client=client_alpha).get(URL, {"marginBelowPercent": "12"})
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_conflicts_are_asked_for_one_flight(
    as_role: Callable[..., APIClient], three_flights: list[Flight], aircraft: Aircraft
) -> None:
    from fleet.models import Aircraft as AircraftModel
    from fleet.models import AircraftStatus

    AircraftModel.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.AOG)
    flight = three_flights[0]
    window = {
        "from": (flight.std_utc - timedelta(minutes=1)).isoformat(),
        "to": (flight.std_utc + timedelta(minutes=1)).isoformat(),
    }

    body = as_role(Role.DISPATCHER).get(f"{URL}/conflicts", window).json()

    assert {item["flightId"] for item in body["data"]} == {flight.pk}
