"""Слоты в координируемых аэропортах `[ТЗ 3.1.1, 3.2.1, 4.2]` (ADR-026).

Подключения к слот-координации не существует, поэтому проверяется
поведение **инструмента подготовки переписки**: черновик собирается
по реестру, ответ координатора разбирается и предлагается, а применяет
его человек.

Отдельно проверяется отказ: слот, по которому ответ уже получен, второй
раз не отвечают — иначе подтверждённый слот можно молча переписать.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from catalog.models import AircraftCategory, AircraftType, Airport
from core.clock import now
from fleet.models import Aircraft
from flights.models import Flight, Slot, SlotStatus, SlotType
from flights.services import slots as slot_services

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import Organization
    from counterparties.models import Client

pytestmark = pytest.mark.django_db

URL = "/api/v1/slots"


@pytest.fixture
def coordinated_airport(db: None) -> Airport:
    return Airport.objects.create(
        icao="UUEE",
        iata="SVO",
        name_ru="Шереметьево",
        name_en="Sheremetyevo",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.9726,
        lon=37.4146,
        is_coordinated=True,
    )


@pytest.fixture
def departure_airport(db: None) -> Airport:
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
        registration="RA-10500", type=aircraft_type, home_base_icao="UUWW"
    )


@pytest.fixture
def flight(
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    coordinated_airport: Airport,
    departure_airport: Airport,
) -> Flight:
    departure = datetime(2026, 9, 20, 12, 30, tzinfo=UTC)
    return Flight.objects.create(
        organization=organization,
        number="SLG-6001",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="UUEE",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=1),
        pax_count=8,
        billing_currency="RUB",
    )


@pytest.fixture
def slot(flight: Flight) -> Slot:
    return Slot.objects.create(
        flight=flight,
        airport_icao="UUEE",
        type=SlotType.ARRIVAL,
        requested_utc=datetime(2026, 9, 20, 13, 30, tzinfo=UTC),
        status=SlotStatus.REQUESTED,
    )


# ─────────────────────────── Сезон и дата ───────────────────────────


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        # Зимний сезон 2025/26 длится до последнего воскресенья марта
        (date(2026, 1, 15), "W25"),
        (date(2026, 3, 28), "W25"),
        (date(2026, 3, 29), "S26"),
        (date(2026, 9, 20), "S26"),
        (date(2026, 10, 24), "S26"),
        (date(2026, 10, 25), "W26"),
        (date(2026, 12, 31), "W26"),
    ],
)
def test_season_code_follows_the_iata_calendar(moment: date, expected: str) -> None:
    """Границы сезона считаются, а не берутся таблицей: та устаревает."""
    assert slot_services.season_code(moment) == expected


def test_date_is_formatted_as_ssim_expects() -> None:
    assert slot_services.ssim_date(date(2026, 9, 5)) == "05SEP"


# ─────────────────────────── Черновик SCR ───────────────────────────


def test_scr_carries_the_slot_details(slot: Slot) -> None:
    text = slot_services.build_scr(slot)
    lines = text.split("\n")

    assert lines[0] == "SCR"
    assert lines[1] == "S26"
    # Аэропорт слота — трёхбуквенным кодом IATA, как требует формат
    assert lines[3] == "SVO"
    # Время движения и его тип: прилёт в 13:30
    assert "1330A" in text
    # Второй конец маршрута — аэропорт вылета
    assert "VKO" in text
    assert "RA-10500" in text


def test_scr_falls_back_to_icao_when_there_is_no_iata_code(
    slot: Slot, coordinated_airport: Airport
) -> None:
    """Пустое место в сообщении координатору читалось бы как сбой системы."""
    coordinated_airport.iata = ""
    coordinated_airport.save()

    assert "UUEE" in slot_services.build_scr(slot)


def test_endpoint_assigns_a_message_number(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(f"{URL}/{slot.pk}/scr", format="json")

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["messageRef"].startswith("SCR-2026-")
    assert body["text"].startswith("SCR\n")

    slot.refresh_from_db()
    assert slot.message_number == body["messageRef"]


def test_message_number_is_assigned_once(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    """Ответ координатора ссылается на номер: второй номер оборвал бы связь."""
    api = as_role(Role.DISPATCHER)
    first = api.post(f"{URL}/{slot.pk}/scr", format="json").json()["messageRef"]
    second = api.post(f"{URL}/{slot.pk}/scr", format="json").json()["messageRef"]

    assert first == second


def test_prepared_message_is_referenced_in_the_draft(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    api.post(f"{URL}/{slot.pk}/scr", format="json")
    text = api.post(f"{URL}/{slot.pk}/scr", format="json").json()["text"]

    slot.refresh_from_db()
    assert f"GI REF {slot.message_number}" in text


# ─────────────────────────── Разбор ответа ───────────────────────────


def test_confirmation_with_a_time_is_understood(slot: Slot) -> None:
    answer = slot_services.parse_answer(
        "SVO SLOT CONFIRMED 1345Z FOR SLG6001", slot=slot
    )

    assert answer.status == SlotStatus.CONFIRMED
    assert answer.confirmed_utc == datetime(2026, 9, 20, 13, 45, tzinfo=UTC)


def test_refusal_to_confirm_is_read_as_refusal(slot: Slot) -> None:
    """«Unable to confirm» содержит оба признака — и это отказ."""
    answer = slot_services.parse_answer("UNABLE TO CONFIRM 1330, SLOT FULL", slot=slot)
    assert answer.status == SlotStatus.REJECTED


def test_unclear_answer_stays_unclear(slot: Slot) -> None:
    """Свободный текст координатора не обязан укладываться в правила."""
    answer = slot_services.parse_answer("Please call the coordinator", slot=slot)

    assert answer.status == ""
    assert answer.confirmed_utc is None


def test_confirmation_without_a_time_keeps_the_requested_one(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{slot.pk}/apply", {"text": "Slot confirmed as requested"}, format="json"
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["status"] == SlotStatus.CONFIRMED
    slot.refresh_from_db()
    assert slot.confirmed_utc == slot.requested_utc


# ─────────────────────────── Применение ───────────────────────────


def test_applying_an_answer_moves_the_slot(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{slot.pk}/apply",
        {"text": "SVO SLOT CONFIRMED 1400Z"},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["status"] == SlotStatus.CONFIRMED
    assert body["confirmedTimeUtc"].startswith("2026-09-20T14:00")
    # Выдержка из письма остаётся в карточке: видно основание
    assert "CONFIRMED" in body["comment"]


def test_unclear_answer_is_refused_and_explains_itself(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{slot.pk}/apply", {"text": "Please call the coordinator"}, format="json"
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "note" in response.json()["error"]["details"]
    slot.refresh_from_db()
    assert slot.status == SlotStatus.REQUESTED


def test_dispatcher_can_decide_manually(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    """Разбор не понял — решение принимает человек, а не система."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{slot.pk}/apply",
        {
            "text": "Please call the coordinator",
            "status": "confirmed",
            "confirmedTimeUtc": "2026-09-20T13:15:00Z",
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["confirmedTimeUtc"].startswith("2026-09-20T13:15")


def test_answered_slot_is_not_answered_twice(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    api.post(f"{URL}/{slot.pk}/apply", {"text": "confirmed 1400"}, format="json")
    again = api.post(f"{URL}/{slot.pk}/apply", {"text": "rejected"}, format="json")

    assert again.status_code == status.HTTP_409_CONFLICT
    assert again.json()["error"]["code"] == "SLOT_ALREADY_ANSWERED"


def test_rejection_clears_the_confirmed_time(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{slot.pk}/apply", {"text": "SLOT REJECTED, NO CAPACITY"}, format="json"
    )

    assert response.json()["status"] == SlotStatus.REJECTED
    assert response.json()["confirmedTimeUtc"] is None


def test_application_is_written_to_the_audit(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    from audit.models import AuditEntry

    api = as_role(Role.DISPATCHER)
    api.post(f"{URL}/{slot.pk}/apply", {"text": "confirmed 1400"}, format="json")

    entry = AuditEntry.objects.filter(
        entity_type="flight", entity_id=slot.flight_id, action="slot_answer_applied"
    ).first()
    assert entry is not None
    assert entry.actor_role == Role.DISPATCHER


# ─────────────────────────── Новый запрос ───────────────────────────


def test_new_slot_request_is_created(
    as_role: Callable[..., APIClient], flight: Flight, coordinated_airport: Airport
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        {
            "flightId": flight.pk,
            "airportIcao": "uuee",
            "kind": "departure",
            "requestedTimeUtc": "2026-09-20T12:30:00Z",
        },
        format="json",
        headers={"Idempotency-Key": "slot-key-000001"},
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    body = response.json()
    # Код аэропорта приводится к верхнему регистру
    assert body["airportIcao"] == "UUEE"
    assert body["status"] == SlotStatus.REQUESTED


def test_request_for_a_missing_flight_is_not_found(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        {
            "flightId": "flt_00000000000000000000",
            "airportIcao": "UUEE",
            "kind": "arrival",
            "requestedTimeUtc": "2026-09-20T12:30:00Z",
        },
        format="json",
        headers={"Idempotency-Key": "slot-key-000002"},
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_second_slot_for_the_same_leg_is_refused(
    as_role: Callable[..., APIClient], slot: Slot, flight: Flight
) -> None:
    """Один слот на связку рейс-аэропорт-движение: второй означал бы два места."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        {
            "flightId": flight.pk,
            "airportIcao": "UUEE",
            "kind": "arrival",
            "requestedTimeUtc": "2026-09-20T14:30:00Z",
        },
        format="json",
        headers={"Idempotency-Key": "slot-key-000003"},
    )
    assert response.status_code >= status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("action", ["scr", "apply"])
def test_portal_role_cannot_touch_slots(
    as_role: Callable[..., APIClient], slot: Slot, action: str, client_alpha: Any
) -> None:
    api = as_role(Role.CLIENT, client=client_alpha)
    response = api.post(f"{URL}/{slot.pk}/{action}", {}, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_slot_list_shows_the_registry(
    as_role: Callable[..., APIClient], slot: Slot
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.get(f"{URL}?flightId={slot.flight_id}")

    assert response.status_code == status.HTTP_200_OK
    assert len(response.json()["data"]) == 1


def test_clock_is_not_frozen_in_the_draft(slot: Slot) -> None:
    """Дата сообщения — сегодняшняя, а дата слота — его собственная."""
    text = slot_services.build_scr(slot)
    assert slot_services.ssim_date(now()) in text
    assert slot_services.ssim_date(slot.requested_utc) in text
