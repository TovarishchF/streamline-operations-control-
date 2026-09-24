"""Учётные записи для экрана входа `[ТЗ 4.3]` (ADR-013).

Список экономит набор логина, когда стенд показывают нескольким людям
подряд. Проверяется ровно то, чем он опасен: что он не отдаёт паролей
и что вне стенда его нет.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from django.test import override_settings
from rest_framework import status

if TYPE_CHECKING:
    from rest_framework.test import APIClient

    from accounts.models import User

pytestmark = pytest.mark.django_db

URL = "/api/v1/auth/accounts"


@override_settings(DEMO_ACCOUNTS=True)
def test_accounts_are_listed_on_the_stand(api: APIClient, dispatcher: User) -> None:
    response = api.get(URL)

    assert response.status_code == status.HTTP_200_OK
    rows = response.json()["data"]
    assert dispatcher.username in [row["username"] for row in rows]


@override_settings(DEMO_ACCOUNTS=True)
def test_the_list_never_carries_a_password(api: APIClient, dispatcher: User) -> None:
    """Список экономит набор логина, а не заменяет вход."""
    row = api.get(URL).json()["data"][0]

    assert set(row) == {"username", "name", "role"}
    assert "password" not in response_text(api)


def response_text(api: APIClient) -> str:
    return str(api.get(URL).content.decode("utf-8")).lower()


@override_settings(DEMO_ACCOUNTS=False)
def test_outside_the_stand_the_list_is_empty(api: APIClient, dispatcher: User) -> None:
    """Перечень действующих сотрудников — не публичные данные."""
    assert api.get(URL).json()["data"] == []


@override_settings(DEMO_ACCOUNTS=True)
def test_the_list_is_open_without_a_token(api: APIClient, dispatcher: User) -> None:
    """Экран входа обращается к нему до входа — иначе он бесполезен."""
    api.credentials()
    assert api.get(URL).status_code == status.HTTP_200_OK


@override_settings(DEMO_ACCOUNTS=True)
def test_deactivated_account_is_not_offered(api: APIClient, dispatcher: User) -> None:
    """Предлагать вход тем, кому вход закрыт, — приглашение в тупик."""
    dispatcher.is_active = False
    dispatcher.save(update_fields=["is_active"])

    assert dispatcher.username not in [
        row["username"] for row in api.get(URL).json()["data"]
    ]
