"""Подписки на отчёты по расписанию `[ТЗ 3.6.3]` (`SPEC.md § 9.3`).

Существенное здесь одно: отписка снимает признак, а не удаляет запись.
История отправок ссылается на подписку, и удаление оборвало бы эти ссылки.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from reports import definitions
from reports.models import ReportSubscription

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Client

pytestmark = pytest.mark.django_db

URL = "/api/v1/report-subscriptions"


def idempotent(key: str = "sub-key-00000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


def payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "code": definitions.FINANCIAL,
        "schedule": "weekly",
        "timeUtc": "06:30",
        "format": "xlsx",
        "recipients": ["finance@example.test"],
        "parameters": {"clientId": ""},
    }
    body.update(overrides)
    return body


@pytest.fixture
def subscription(as_role: Callable[..., APIClient]) -> dict[str, Any]:
    # Отдельный суффикс: тест рядом входит той же ролью, а логины
    # пользователей уникальны.
    api = as_role(Role.FINANCE, suffix="subfix")
    created = api.post(URL, payload(), format="json", headers=idempotent())
    assert created.status_code == status.HTTP_201_CREATED, created.data
    return dict(created.json())


def test_subscription_is_created_and_listed(
    as_role: Callable[..., APIClient], subscription: dict[str, Any]
) -> None:
    api = as_role(Role.FINANCE)
    listed = api.get(URL)

    assert listed.status_code == status.HTTP_200_OK
    codes = [item["id"] for item in listed.json()["data"]]
    assert subscription["id"] in codes
    assert subscription["timeUtc"] == "06:30"
    assert subscription["format"] == "xlsx"


def test_creation_is_written_to_the_audit(subscription: dict[str, Any]) -> None:
    entry = AuditEntry.objects.filter(
        entity_type="report_subscription", entity_id=subscription["id"]
    ).first()
    assert entry is not None
    assert entry.action == "created"


def test_subscription_to_unknown_report_is_refused(
    as_role: Callable[..., APIClient],
) -> None:
    """Подписка на несуществующий отчёт не сработает никогда — отказ сразу."""
    api = as_role(Role.FINANCE)
    response = api.post(
        URL,
        payload(code="margin_by_moon_phase"),
        format="json",
        headers=idempotent("sub-bad-000001"),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("value", ["25:00", "6:30", "06:70", "утром"])
def test_impossible_time_is_refused(
    as_role: Callable[..., APIClient], value: str
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        URL, payload(timeUtc=value), format="json", headers=idempotent(f"sub-{len(value)}-t")
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_subscription_without_recipients_is_refused(
    as_role: Callable[..., APIClient],
) -> None:
    """Отчёт некому отправить — подписка бессмысленна."""
    api = as_role(Role.FINANCE)
    response = api.post(
        URL, payload(recipients=[]), format="json", headers=idempotent("sub-norec-001")
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_subscription_can_be_changed(
    as_role: Callable[..., APIClient], subscription: dict[str, Any]
) -> None:
    api = as_role(Role.FINANCE)
    changed = api.patch(
        f"{URL}/{subscription['id']}", {"schedule": "monthly", "format": "pdf"}, format="json"
    )

    assert changed.status_code == status.HTTP_200_OK, changed.data
    assert changed.json()["schedule"] == "monthly"
    assert changed.json()["format"] == "pdf"


def test_change_is_written_to_the_audit_with_diff(
    as_role: Callable[..., APIClient], subscription: dict[str, Any]
) -> None:
    api = as_role(Role.FINANCE)
    api.patch(f"{URL}/{subscription['id']}", {"schedule": "daily"}, format="json")

    entry = AuditEntry.objects.filter(
        entity_type="report_subscription", entity_id=subscription["id"], action="updated"
    ).first()
    assert entry is not None
    assert entry.before is not None and entry.after is not None
    assert entry.before["schedule"] == "weekly"
    assert entry.after["schedule"] == "daily"


def test_unsubscribe_deactivates_but_keeps_the_record(
    as_role: Callable[..., APIClient], subscription: dict[str, Any]
) -> None:
    """История отправок ссылается на подписку, поэтому запись остаётся."""
    api = as_role(Role.FINANCE)
    response = api.delete(f"{URL}/{subscription['id']}")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    stored = ReportSubscription.objects.get(pk=subscription["id"])
    assert stored.is_active is False

    assert [item["id"] for item in api.get(URL).json()["data"]] == []


def test_deactivated_subscription_cannot_be_changed(
    as_role: Callable[..., APIClient], subscription: dict[str, Any]
) -> None:
    api = as_role(Role.FINANCE)
    api.delete(f"{URL}/{subscription['id']}")

    response = api.patch(f"{URL}/{subscription['id']}", {"schedule": "daily"}, format="json")
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_creation_requires_idempotency_key(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(URL, payload(), format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_portal_role_cannot_subscribe(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    api = as_role(Role.CLIENT, client=client_alpha)
    response = api.post(URL, payload(), format="json", headers=idempotent("sub-cli-00001"))
    assert response.status_code == status.HTTP_403_FORBIDDEN
