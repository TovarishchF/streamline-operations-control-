"""Политика паролей `[ТЗ 4.3]`.

Проверяется не только то, что слабый пароль отклоняется, но и то, что
правило действует **на всех путях**: правило, работающее в одной форме
из трёх, — не политика.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from rest_framework import status

from accounts.password_policy import SPECIAL

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

GOOD = "Parol-Dlya-Stenda-2026!"


def messages(password: str) -> list[str]:
    try:
        validate_password(password)
    except ValidationError as error:
        return list(error.messages)
    return []


def test_a_good_password_passes() -> None:
    assert messages(GOOD) == []


@pytest.mark.parametrize(
    ("password", "expected"),
    [
        ("1234567890-12", "буквы"),
        ("ParolBezTsifr-", "цифры"),
        ("ParolBezZnaka2026", "знак препинания"),
    ],
)
def test_incomplete_password_is_refused(password: str, expected: str) -> None:
    assert any(expected in message for message in messages(password))


@pytest.mark.parametrize("char", ['"', "'", "\\", "/", "<", ">", "|", "`", " "])
def test_characters_that_get_lost_in_transit_are_refused(char: str) -> None:
    """Кавычки подменяются редакторами, косая и вертикальная теряются
    при пересылке через терминал и таблицы."""
    assert any("использовать нельзя" in message for message in messages(f"Parol2026{char}x"))


def test_cyrillic_is_refused() -> None:
    """Пароль в русской раскладке нельзя ввести на чужой клавиатуре."""
    assert any("использовать нельзя" in message for message in messages("Пароль2026-abc"))


def test_every_allowed_special_is_accepted() -> None:
    """Перечень из подсказки обязан работать целиком.

    Иначе пользователь выбирает знак из подсказки и получает отказ.
    """
    for char in SPECIAL:
        assert messages(f"ParolStenda2026{char}") == [], f"знак {char} отклонён"


# ─────────────────── Правило действует на всех путях ───────────────────


@pytest.mark.django_db
def test_registration_applies_the_policy(api: APIClient, organization: Any) -> None:
    payload = {
        "kind": "client",
        "contactName": "Мария Львовна Соболева",
        "email": "policy@example.test",
        "password": "ParolBezTsifr-",
        "companyName": "Чартер Восток",
    }
    response = api.post("/api/v1/auth/register", payload, format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.django_db
def test_password_change_applies_the_policy(as_role: Callable[..., APIClient]) -> None:
    """Тот же отказ на другом пути входа пароля в систему."""
    from accounts.models import Role
    from tests.factories import PASSWORD

    api = as_role(Role.DISPATCHER)
    response = api.post(
        "/api/v1/auth/password",
        {"currentPassword": PASSWORD, "newPassword": "ParolBezZnaka2026"},
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
