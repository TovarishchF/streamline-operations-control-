"""Внутренние уведомления `[ТЗ 3.5.1]` (`SPEC.md § 8.1`).

Уведомление адресное. Проверяется главное: колокольчик показывает **свои**
уведомления и только их — включая портальные роли, у которых нет права
на переписку, но есть свои события по своим заявкам.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from comms.models import Notification
from comms.services import notifications

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User
    from counterparties.models import Client, Vendor

pytestmark = pytest.mark.django_db

URL = "/api/v1/notifications"


def test_bell_shows_only_own_notifications(
    api: APIClient, make_user: Callable[..., User]
) -> None:
    reader = make_user(Role.DISPATCHER, suffix="reader")
    stranger = make_user(Role.DISPATCHER, suffix="other")

    notifications.notify(user=reader, kind="deadline", title="Моё")
    notifications.notify(user=stranger, kind="deadline", title="Чужое")

    api.force_authenticate(user=reader)
    titles = [item["title"] for item in api.get(URL).json()["data"]]

    assert titles == ["Моё"]


@pytest.mark.parametrize("role", [Role.CLIENT, Role.VENDOR])
def test_portal_roles_see_their_notifications(
    api: APIClient,
    make_user: Callable[..., User],
    role: str,
    client_alpha: Client,
    vendor_alpha: Vendor,
) -> None:
    """Событие по своей заявке поставщик видеть обязан.

    Право на переписку у портальных ролей не выдано, и эндпоинт не должен
    закрываться этим правом: ограничение здесь — связь с пользователем.
    """
    extra: dict[str, Any] = (
        {"client": client_alpha} if role == Role.CLIENT else {"vendor": vendor_alpha}
    )
    owner = make_user(role, suffix="portal", **extra)
    notifications.notify(user=owner, kind="service_confirmed", title="Ваша заявка")

    api.force_authenticate(user=owner)
    response = api.get(URL)

    assert response.status_code == status.HTTP_200_OK, response.data
    assert [item["title"] for item in response.json()["data"]] == ["Ваша заявка"]


def test_anonymous_gets_nothing(api: APIClient) -> None:
    """Без входа колокольчик не отдаёт ничего."""
    assert api.get(URL).status_code in (
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    )


def test_unread_filter(
    api: APIClient, make_user: Callable[..., User]
) -> None:
    reader = make_user(Role.DISPATCHER, suffix="reader")
    read = notifications.notify(user=reader, kind="deadline", title="Прочитанное")
    notifications.notify(user=reader, kind="deadline", title="Новое")
    notifications.mark_read(notification=read)

    api.force_authenticate(user=reader)
    assert len(api.get(URL).json()["data"]) == 2
    unread = api.get(f"{URL}?unreadOnly=true").json()
    assert [item["title"] for item in unread["data"]] == ["Новое"]
    # Счётчик колокольчика берётся из мета-данных этой же выборки
    assert unread["meta"]["total"] == 1


def test_kind_filter(
    api: APIClient, make_user: Callable[..., User]
) -> None:
    reader = make_user(Role.DISPATCHER, suffix="reader")
    notifications.notify(user=reader, kind="sla_breach", title="SLA")
    notifications.notify(user=reader, kind="deadline", title="Срок")

    api.force_authenticate(user=reader)
    rows = api.get(f"{URL}?kind=sla_breach").json()["data"]
    assert [item["title"] for item in rows] == ["SLA"]


def test_marking_read_is_idempotent(
    api: APIClient, make_user: Callable[..., User]
) -> None:
    """Повторная отметка не переписывает время прочтения."""
    reader = make_user(Role.DISPATCHER, suffix="reader")
    item = notifications.notify(user=reader, kind="deadline", title="Срок")

    api.force_authenticate(user=reader)
    assert api.post(f"{URL}/{item.pk}/read").status_code == status.HTTP_204_NO_CONTENT
    first = Notification.objects.get(pk=item.pk).read_at

    assert api.post(f"{URL}/{item.pk}/read").status_code == status.HTTP_204_NO_CONTENT
    assert Notification.objects.get(pk=item.pk).read_at == first


def test_cannot_mark_someone_elses_notification(
    api: APIClient, make_user: Callable[..., User]
) -> None:
    """Чужая запись не существует для читателя — 404, а не 403."""
    stranger = make_user(Role.DISPATCHER, suffix="other")
    reader = make_user(Role.DISPATCHER, suffix="reader")
    foreign = notifications.notify(user=stranger, kind="deadline", title="Чужое")

    api.force_authenticate(user=reader)
    assert api.post(f"{URL}/{foreign.pk}/read").status_code == status.HTTP_404_NOT_FOUND


def test_severity_comes_from_the_event_kind(
    make_user: Callable[..., User],
) -> None:
    """Одно событие не может быть то предупреждением, то критичным."""
    reader = make_user(Role.DISPATCHER, suffix="sev")

    assert notifications.notify(user=reader, kind="sla_breach", title="x").severity == "critical"
    assert notifications.notify(user=reader, kind="flight_status", title="y").severity == "info"
    assert (
        notifications.notify(user=reader, kind="service_rejected", title="z").severity
        == "warning"
    )
