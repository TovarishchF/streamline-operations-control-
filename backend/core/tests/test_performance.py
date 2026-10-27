"""Замеры нормативов ТЗ 4.4 (ADR-017, `SPEC.md § 10.4`).

`/admin/performance` показывает перцентили по фактическим замерам:
серверным — время ответа карточки рейса и расчёта маржи, клиентским —
время от навигации до отрисовки экрана, присланное веб-клиентом.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import pytest
from rest_framework import status

from accounts.models import Organization, Role
from core.clock import now, real_now
from core.models import PerformanceSample, PerformanceSource
from counterparties.models import Client
from flights.models import Flight

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

SAMPLES = "/api/v1/performance/samples"
REPORT = "/api/v1/performance"


@pytest.fixture
def flight(organization: Organization, client_alpha: Client) -> Flight:
    departure = now() + timedelta(days=1)
    return Flight.objects.create(
        organization=organization,
        number="SLG-4001",
        client=client_alpha,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=2,
        billing_currency="RUB",
    )


def test_flight_card_and_margin_are_measured_on_the_server(
    as_role: Callable[..., APIClient], flight: Flight
) -> None:
    api = as_role(Role.DISPATCHER)
    assert api.get(f"/api/v1/flights/{flight.pk}").status_code == status.HTTP_200_OK
    assert api.get(f"/api/v1/flights/{flight.pk}/margin").status_code == status.HTTP_200_OK
    # Список рейсов — не карточка: его время в норматив карточки не идёт.
    api.get("/api/v1/flights")

    names = sorted(
        PerformanceSample.objects.filter(source=PerformanceSource.SERVER).values_list(
            "name", flat=True
        )
    )
    assert names == ["flight_card", "margin_calc"]


def test_client_samples_are_accepted(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.DISPATCHER).post(
        SAMPLES,
        {
            "samples": [
                {
                    "name": "flight_card",
                    "durationMs": 840,
                    "route": "/flights/:id",
                    "kind": "navigation",
                },
                {"name": "flight_card", "durationMs": 1630, "kind": "initial_load"},
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_202_ACCEPTED, response.json()
    assert response.json() == {"accepted": 2}
    assert PerformanceSample.objects.filter(source=PerformanceSource.CLIENT).count() == 2


@pytest.mark.parametrize(
    "body",
    [
        {"samples": [{"name": "dashboard", "durationMs": 100}]},
        {"samples": [{"name": "flight_card", "durationMs": -5}]},
        {"samples": []},
        {"samples": [{"name": "flight_card", "durationMs": 100}] * 51},
    ],
)
def test_impossible_samples_are_refused(
    as_role: Callable[..., APIClient], body: dict[str, object]
) -> None:
    assert as_role(Role.DISPATCHER).post(SAMPLES, body, format="json").status_code == (
        status.HTTP_400_BAD_REQUEST
    )


def test_anonymous_cannot_send_samples(api: APIClient) -> None:
    response = api.post(SAMPLES, {"samples": [{"name": "flight_card", "durationMs": 1}]})
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_report_shows_measured_percentiles(as_role: Callable[..., APIClient]) -> None:
    moment = real_now()
    PerformanceSample.objects.bulk_create(
        PerformanceSample(
            name="flight_card",
            source=PerformanceSource.SERVER,
            duration_ms=value,
            recorded_at=moment,
        )
        for value in [*range(100, 2000, 100), 2500]
    )

    body = as_role(Role.ADMIN).get(REPORT).json()
    metrics = {(item["name"], item["source"]): item for item in body["metrics"]}

    server = metrics[("flight_card", "server")]
    assert server["sampleCount"] == 20
    assert server["p50Ms"] == 1000
    assert server["p95Ms"] == 1900
    assert server["p99Ms"] == 2500
    assert server["thresholdMs"] == 2000
    assert server["withinThreshold"] is True
    # Без замеров норматив не выполнен и не нарушен.
    assert metrics[("flight_card", "client")]["withinThreshold"] is None
    assert metrics[("margin_calc", "server")]["sampleCount"] == 0


def test_report_is_for_the_administrator(as_role: Callable[..., APIClient]) -> None:
    assert as_role(Role.MANAGER).get(REPORT).status_code == status.HTTP_403_FORBIDDEN
