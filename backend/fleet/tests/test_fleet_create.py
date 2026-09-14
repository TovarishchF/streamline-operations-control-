"""Постановка борта в парк `[ТЗ 3.1.3]`."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntityType, AuditEntry
from catalog.models import AircraftCategory, AircraftType, Airport
from fleet.models import Aircraft

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Client

pytestmark = pytest.mark.django_db

FLEET_URL = "/api/v1/fleet"


def idempotent(key: str = "fleet-key-000001") -> dict[str, str]:
    """Заголовок идемпотентности (ADR-018)."""
    return {"Idempotency-Key": key}


@pytest.fixture
def aircraft_type(db: None) -> AircraftType:
    return AircraftType.objects.create(
        icao_type="GLF5",
        name_ru="Gulfstream G550",
        name_en="Gulfstream G550",
        category=AircraftCategory.HEAVY,
        seats=16,
        cruise_speed_kts=488,
        fuel_burn_kg_per_hour=1300,
        turnaround_min=60,
    )


@pytest.fixture
def base_airport(db: None) -> Airport:
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


def payload(aircraft_type: AircraftType, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "registration": "ra-10201",
        "typeId": aircraft_type.pk,
        "homeBaseIcao": "uuww",
        "status": "serviceable",
        "approvals": [
            {
                "kind": "RVSM",
                "number": "RVSM-2026-77",
                "validFrom": "2026-01-01T00:00:00Z",
                "validTo": "2028-01-01T00:00:00Z",
            }
        ],
    }
    body.update(overrides)
    return body


def test_aircraft_is_added_with_approvals(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
) -> None:
    api = as_role(Role.DISPATCHER)
    created = api.post(FLEET_URL, payload(aircraft_type), format="json", headers=idempotent())

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    # Бортовой номер и база приведены к верхнему регистру
    assert body["registration"] == "RA-10201"
    assert body["homeBaseIcao"] == "UUWW"
    assert body["type"]["icaoType"] == "GLF5"
    assert body["approvals"][0]["kind"] == "RVSM"

    listed = api.get(FLEET_URL)
    assert [row["id"] for row in listed.json()["data"]] == [body["id"]]


def test_registration_case_does_not_create_second_aircraft(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
) -> None:
    """`ra-10201` и `RA-10201` — один борт: два расписания на одну машину недопустимы."""
    api = as_role(Role.DISPATCHER)
    api.post(FLEET_URL, payload(aircraft_type), format="json", headers=idempotent("fleet-a-000001"))
    duplicate = api.post(
        FLEET_URL,
        payload(aircraft_type, registration="RA-10201"),
        format="json",
        headers=idempotent("fleet-b-000002"),
    )
    assert duplicate.status_code == status.HTTP_400_BAD_REQUEST
    assert Aircraft.objects.count() == 1


def test_unknown_home_base_is_rejected(
    as_role: Callable[..., APIClient], aircraft_type: AircraftType
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        FLEET_URL, payload(aircraft_type, homeBaseIcao="ZZZZ"), format="json", headers=idempotent()
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_approval_with_end_before_start_is_rejected(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
) -> None:
    """Истёкший допуск даёт конфликт расписания (ADR-027) — даты обязаны быть связными."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        FLEET_URL,
        payload(
            aircraft_type,
            approvals=[
                {
                    "kind": "ETOPS",
                    "number": "E-1",
                    "validFrom": "2027-01-01T00:00:00Z",
                    "validTo": "2026-01-01T00:00:00Z",
                }
            ],
        ),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_aircraft_creation_is_written_to_audit(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
) -> None:
    api = as_role(Role.DISPATCHER)
    created = api.post(FLEET_URL, payload(aircraft_type), format="json", headers=idempotent())

    entry = AuditEntry.objects.get(
        entity_type=AuditEntityType.AIRCRAFT, entity_id=created.json()["id"]
    )
    assert entry.action == "created"


def test_client_portal_cannot_add_aircraft(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
    client_alpha: Client,
) -> None:
    api = as_role(Role.CLIENT, client=client_alpha)
    response = api.post(FLEET_URL, payload(aircraft_type), format="json", headers=idempotent())
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_client_sees_only_own_aircraft(
    as_role: Callable[..., APIClient],
    aircraft_type: AircraftType,
    base_airport: Airport,
    client_alpha: Client,
    client_beta: Client,
) -> None:
    """Тест на протечку данных для портала (`BACKEND.md § 3.7`)."""
    Aircraft.objects.create(
        registration="RA-00001",
        type=aircraft_type,
        operator=client_alpha,
        home_base_icao="UUWW",
    )
    Aircraft.objects.create(
        registration="RA-00002",
        type=aircraft_type,
        operator=client_beta,
        home_base_icao="UUWW",
    )

    api = as_role(Role.CLIENT, client=client_alpha)
    rows = api.get(FLEET_URL).json()["data"]
    assert [row["registration"] for row in rows] == ["RA-00001"]
