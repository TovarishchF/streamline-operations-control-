"""Шаблоны регулярных рейсов `[ТЗ 3.1.1]` (`SPEC.md § 4.5`).

Проверяется заведение шаблона: до этого эндпоинт был объявлен в контракте,
но падал — организация не проставлялась, а услуги по умолчанию завести
было нечем.

Время вылета остаётся **местным**: перевод в UTC делается при генерации
серии, на каждую дату отдельно. Шаблон, сохранённый сразу в UTC, ломал бы
расписание дважды в год.
"""

from __future__ import annotations

from datetime import time
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from catalog.models import (
    AircraftCategory,
    AircraftType,
    Airport,
    Service,
    ServiceCategory,
    ServiceUnit,
)
from flights.models import FlightTemplate

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Client

pytestmark = pytest.mark.django_db

URL = "/api/v1/flight-templates"


def idempotent(key: str = "tpl-key-000001") -> dict[str, str]:
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
def airports(db: None) -> None:
    for icao, iata, name in (("UUWW", "VKO", "Внуково"), ("ULLI", "LED", "Пулково")):
        Airport.objects.create(
            icao=icao,
            iata=iata,
            name_ru=name,
            name_en=name,
            country="RU",
            timezone="Europe/Moscow",
            lat=55.0,
            lon=37.0,
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


def payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Москва — Петербург, будни",
        "clientId": "",
        "aircraftTypeId": "",
        "depIcao": "uuww",
        "arrIcao": "ULLI",
        "depTimeLocal": "09:30",
        "weekdays": [1, 2, 3, 4, 5],
        "defaultServices": [],
    }
    body.update(overrides)
    return body


def test_template_is_created(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    body = response.json()
    # Код аэропорта приводится к верхнему регистру
    assert body["depIcao"] == "UUWW"
    assert body["depTimeLocal"] == "09:30"
    assert body["weekdays"] == [1, 2, 3, 4, 5]


def test_template_belongs_to_the_operator_not_the_author(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    """Организация берётся из учётной записи, а не от клиента."""
    api = as_role(Role.DISPATCHER)
    created = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
        headers=idempotent("tpl-org-00001"),
    ).json()

    template = FlightTemplate.objects.get(pk=created["id"])
    assert template.organization_id == client_alpha.organization_id


def test_default_services_are_created_with_the_template(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
    fuel_service: Service,
) -> None:
    """Шаблон без услуг сгенерировал бы серию пустых рейсов."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        payload(
            clientId=client_alpha.pk,
            aircraftTypeId=aircraft_type.pk,
            defaultServices=[
                {"serviceId": fuel_service.pk, "leg": "departure", "attributes": {}}
            ],
        ),
        format="json",
        headers=idempotent("tpl-svc-00001"),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    services = response.json()["defaultServices"]
    assert len(services) == 1
    assert services[0]["serviceId"] == fuel_service.pk


def test_weekdays_are_deduplicated_and_ordered(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    """Повтор дня дал бы два рейса в одни сутки при генерации серии."""
    api = as_role(Role.DISPATCHER)
    body = api.post(
        URL,
        payload(
            clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk, weekdays=[5, 1, 1, 3]
        ),
        format="json",
        headers=idempotent("tpl-days-0001"),
    ).json()

    assert body["weekdays"] == [1, 3, 5]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("weekdays", []),
        ("weekdays", [0]),
        ("weekdays", [8]),
        ("depIcao", "UU"),
        ("depTimeLocal", "25:00"),
    ],
)
def test_impossible_template_is_refused(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
    field: str,
    value: Any,
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk, **{field: value}),
        format="json",
        headers=idempotent(f"tpl-bad-{len(str(value)):02d}-x"),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_creation_requires_idempotency_key(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_creation_is_written_to_the_audit(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    from audit.models import AuditEntry

    api = as_role(Role.DISPATCHER)
    created = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
        headers=idempotent("tpl-audit-001"),
    ).json()

    entry = AuditEntry.objects.filter(
        entity_id=created["id"], action="template_created"
    ).first()
    assert entry is not None
    assert entry.actor_role == Role.DISPATCHER


def test_local_time_is_stored_as_local(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    """Шаблон в UTC ломал бы расписание дважды в год (`SPEC.md § 4.5`)."""
    api = as_role(Role.DISPATCHER)
    created = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
        headers=idempotent("tpl-time-0001"),
    ).json()

    template = FlightTemplate.objects.get(pk=created["id"])
    assert template.dep_time_local == time(9, 30)


def test_portal_role_cannot_create_a_template(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    aircraft_type: AircraftType,
    airports: None,
) -> None:
    api = as_role(Role.CLIENT, client=client_alpha)
    response = api.post(
        URL,
        payload(clientId=client_alpha.pk, aircraftTypeId=aircraft_type.pk),
        format="json",
        headers=idempotent("tpl-cli-00001"),
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN
