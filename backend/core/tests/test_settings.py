"""Настройки системы и модельное время (`DOMAIN.md § 11`, ADR-014).

Модельное время меняется только при включённом генераторе. Ускорение
×60 — это час модельного времени за минуту настоящего, и сервер обязан
считать именно так: автопереходы выполняет Celery по серверным часам.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from django.test import override_settings
from freezegun import freeze_time
from rest_framework import status

from accounts.models import Organization, Role
from audit.models import AuditEntry
from core import clock
from core.models import Settings
from core.services import settings as settings_service
from counterparties.models import Client
from flights.models import Flight

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User

pytestmark = pytest.mark.django_db

URL = "/api/v1/settings"
REAL = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)


def test_admin_reads_the_settings(as_role: Callable[..., APIClient]) -> None:
    body = as_role(Role.ADMIN).get(URL).json()

    assert body["lowMarginThresholdPercent"] == "12.0000"
    assert body["documentNumberMasks"]["invoice"] == "SOC-I-{YYYY}-{NNNN}"
    assert body["contractExpiryReminders"] == [30, 15, 7]
    assert body["slaWeights"]["onTimeConfirm"] == "0.30"
    assert body["sampleData"] is False
    assert body["clockOffsetSeconds"] == 0
    assert body["clockScale"] == 1


def test_dispatcher_has_no_settings(as_role: Callable[..., APIClient]) -> None:
    assert as_role(Role.DISPATCHER).get(URL).status_code == status.HTTP_403_FORBIDDEN


def test_threshold_change_is_audited_and_stored_as_decimal(
    as_role: Callable[..., APIClient],
) -> None:
    response = as_role(Role.ADMIN).patch(URL, {"lowMarginThresholdPercent": "15.5"}, format="json")

    assert response.status_code == status.HTTP_200_OK, response.json()
    assert response.json()["lowMarginThresholdPercent"] == "15.5000"
    assert Settings.get_solo().low_margin_threshold_percent == Decimal("15.5")
    entry = AuditEntry.objects.get(entity_type="settings", action="updated")
    assert entry.after == {"low_margin_threshold_percent": "15.5000"}


@pytest.mark.parametrize(
    "changes",
    [
        {"documentNumberMasks": {"invoice": "INV-{NNNN}"}},
        {"slaWeights": {"onTimeConfirm": "-1"}},
        {
            "slaWeights": {
                "onTimeConfirm": "0",
                "slaCompliance": "0",
                "billing": "0",
                "quality": "0",
            }
        },
        {"slaWeights": {"speed": "1"}},
        {"contractExpiryReminders": [0]},
        {"lowMarginThresholdPercent": "много"},
        {"fxPolicy": "payment_date"},
        {"deicingRule": {"tempAlwaysC": 40}},
    ],
)
def test_impossible_values_are_refused(
    as_role: Callable[..., APIClient], changes: dict[str, object]
) -> None:
    response = as_role(Role.ADMIN).patch(URL, changes, format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


@override_settings(SAMPLE_DATA=False)
def test_model_time_is_closed_without_the_generator(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.ADMIN).patch(URL, {"clockOffsetSeconds": 3600}, format="json")

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.json()["error"]["code"] == "SAMPLE_DATA_DISABLED"


@override_settings(SAMPLE_DATA=True)
def test_rewind_moves_the_server_clock(make_user: Callable[..., User]) -> None:
    admin = make_user(Role.ADMIN, suffix="clock")
    with freeze_time(REAL):
        settings_service.update(changes={"clockOffsetSeconds": 6 * 3600}, actor=admin)
        assert clock.now() == REAL + timedelta(hours=6)
        assert clock.is_shifted() is True


@override_settings(SAMPLE_DATA=True)
def test_acceleration_makes_an_hour_pass_in_a_minute(make_user: Callable[..., User]) -> None:
    admin = make_user(Role.ADMIN, suffix="clock")
    with freeze_time(REAL) as frozen:
        settings_service.update(changes={"clockScale": 60}, actor=admin)
        frozen.tick(timedelta(minutes=1))
        assert clock.now() == REAL + timedelta(hours=1)

        # Смена ускорения не теряет накопленное: модельное время не прыгает.
        settings_service.update(changes={"clockScale": 1}, actor=admin)
        assert clock.now() == REAL + timedelta(hours=1)
        frozen.tick(timedelta(minutes=1))
        assert clock.now() == REAL + timedelta(hours=1, minutes=1)


@override_settings(SAMPLE_DATA=True)
def test_reset_returns_real_time(make_user: Callable[..., User]) -> None:
    admin = make_user(Role.ADMIN, suffix="clock")
    with freeze_time(REAL):
        settings_service.update(changes={"clockOffsetSeconds": 7200}, actor=admin)
        settings_service.update(changes={"clockOffsetSeconds": 0, "clockScale": 1}, actor=admin)
        assert clock.now() == REAL
        assert clock.is_shifted() is False


@override_settings(SAMPLE_DATA=True)
def test_unknown_scale_is_refused(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.ADMIN).patch(URL, {"clockScale": 7}, format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_threshold_change_resets_cached_margins(
    as_role: Callable[..., APIClient],
    organization: Organization,
    client_alpha: Client,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    departure = clock.now() + timedelta(days=1)
    flight = Flight.objects.create(
        organization=organization,
        number="SLG-4101",
        client=client_alpha,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=2,
        billing_currency="RUB",
    )
    api = as_role(Role.ADMIN)
    url = f"/api/v1/flights/{flight.pk}/margin"
    assert api.get(url).json()["thresholdPercent"] == "12.0000"

    with django_capture_on_commit_callbacks(execute=True):
        api.patch(URL, {"lowMarginThresholdPercent": "20"}, format="json")

    assert api.get(url).json()["thresholdPercent"] == "20.0000"
