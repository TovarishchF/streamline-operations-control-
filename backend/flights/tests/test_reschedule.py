"""Перенос рейса: форма и планшет `[ТЗ 3.1.3]` (`SPEC.md § 4.1`).

Сценарий один для формы и для перетаскивания полосы: проверка конфликтов →
подтверждение с причиной → аудит → письма клиенту и поставщикам.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from catalog.models import Service, ServiceCategory, ServiceUnit
from comms.models import MessageChannel, MessageTemplate, OutboxMessage
from core import clock
from counterparties.models import Contact
from fleet.models import Aircraft, AircraftStatus
from flights.models import Flight
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import AircraftType
    from counterparties.models import Client, Vendor

pytestmark = pytest.mark.django_db


def url(flight: Flight) -> str:
    return f"/api/v1/flights/{flight.pk}"


def test_moving_the_bar_keeps_its_length(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight
) -> None:
    duration = flight_with_aircraft.sta_utc - flight_with_aircraft.std_utc
    target = flight_with_aircraft.std_utc + timedelta(hours=3)

    response = as_role(Role.DISPATCHER).patch(
        url(flight_with_aircraft), {"stdUtc": target.isoformat()}, format="json"
    )

    assert response.status_code == status.HTTP_200_OK, response.json()
    flight = Flight.objects.get(pk=flight_with_aircraft.pk)
    assert flight.std_utc == target
    assert flight.sta_utc - flight.std_utc == duration


def test_stretching_the_bar_sets_the_arrival(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight
) -> None:
    arrival = flight_with_aircraft.std_utc + timedelta(hours=4)

    response = as_role(Role.DISPATCHER).patch(
        url(flight_with_aircraft), {"staUtc": arrival.isoformat()}, format="json"
    )

    assert response.status_code == status.HTTP_200_OK
    assert Flight.objects.get(pk=flight_with_aircraft.pk).sta_utc == arrival


def test_arrival_before_departure_is_refused(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight
) -> None:
    response = as_role(Role.DISPATCHER).patch(
        url(flight_with_aircraft),
        {"staUtc": (flight_with_aircraft.std_utc - timedelta(minutes=5)).isoformat()},
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


@pytest.fixture
def broken_aircraft(aircraft_type: AircraftType) -> Aircraft:
    return Aircraft.objects.create(
        registration="RA-67999", type=aircraft_type, status=AircraftStatus.AOG
    )


def test_new_conflict_needs_a_reason(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight, broken_aircraft: Aircraft
) -> None:
    api = as_role(Role.DISPATCHER)
    refused = api.patch(
        url(flight_with_aircraft), {"aircraftId": broken_aircraft.pk}, format="json"
    )

    assert refused.status_code == status.HTTP_409_CONFLICT
    error = refused.json()["error"]
    assert error["code"] == "SCHEDULE_CONFLICT"
    assert error["details"]["conflicts"][0]["kind"] == "aircraft_aog"
    # Отказ ничего не сохранил.
    assert Flight.objects.get(pk=flight_with_aircraft.pk).aircraft_id != broken_aircraft.pk

    confirmed = api.patch(
        url(flight_with_aircraft),
        {"aircraftId": broken_aircraft.pk, "conflictOverrideReason": "Борт выйдет из ремонта"},
        format="json",
    )
    assert confirmed.status_code == status.HTTP_200_OK
    entry = AuditEntry.objects.get(entity_id=flight_with_aircraft.pk, action="schedule_conflict")
    assert "Борт выйдет из ремонта" in entry.comment


def test_unrelated_edit_does_not_ask_about_an_old_conflict(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight, aircraft: Aircraft
) -> None:
    Aircraft.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.AOG)

    response = as_role(Role.DISPATCHER).patch(
        url(flight_with_aircraft), {"remarks": "Трап с подогревом"}, format="json"
    )
    assert response.status_code == status.HTTP_200_OK


@pytest.fixture
def templates(db: None) -> None:
    for code, subject in (
        ("flight_rescheduled", "Изменение расписания: рейс {{flight.number}}"),
        ("order_changed", "Изменение заявки {{order.id}}"),
    ):
        MessageTemplate.objects.create(
            code=code,
            channel=MessageChannel.EMAIL,
            subject_ru=subject,
            subject_en=subject,
            body_ru="Было: {{change.before}}",
            body_en="Was: {{change.before}}",
        )


def test_rescheduling_writes_to_the_client_and_the_vendor(
    as_role: Callable[..., APIClient],
    flight_with_aircraft: Flight,
    client_alpha: Client,
    vendor_alpha: Vendor,
    templates: None,
    django_capture_on_commit_callbacks: Any,
) -> None:
    Contact.objects.create(client=client_alpha, name="Мария Орлова", email="ops@client.test")
    Contact.objects.create(vendor=vendor_alpha, name="Иван Петров", email="ops@vendor.test")
    service = Service.objects.create(
        code="FUEL-X",
        category=ServiceCategory.FUEL,
        name_ru="Топливо",
        name_en="Fuel",
        unit=ServiceUnit.LITRE,
    )
    deadline = flight_with_aircraft.std_utc + timedelta(minutes=90)
    order = ServiceOrder.objects.create(
        flight=flight_with_aircraft,
        service=service,
        leg="departure",
        airport_icao="UUWW",
        vendor=vendor_alpha,
        quantity=Decimal(1),
        sla_completion_deadline=deadline,
    )
    ServiceOrder.objects.filter(pk=order.pk).update(status=ServiceOrderStatus.ORDERED)
    target = flight_with_aircraft.std_utc + timedelta(days=1)

    with django_capture_on_commit_callbacks(execute=True):
        response = as_role(Role.DISPATCHER).patch(
            url(flight_with_aircraft), {"stdUtc": target.isoformat()}, format="json"
        )

    assert response.status_code == status.HTTP_200_OK, response.json()
    codes = sorted(OutboxMessage.objects.values_list("template_code", flat=True))
    assert codes == ["flight_rescheduled", "order_changed"]
    # Срок исполнения ушёл вслед за рейсом.
    assert ServiceOrder.objects.get(pk=order.pk).sla_completion_deadline == deadline + timedelta(
        days=1
    )


def test_client_cannot_move_flights(
    as_role: Callable[..., APIClient], flight_with_aircraft: Flight, client_alpha: Client
) -> None:
    response = as_role(Role.CLIENT, client=client_alpha).patch(
        url(flight_with_aircraft),
        {"stdUtc": (clock.now() + timedelta(days=2)).isoformat()},
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN
