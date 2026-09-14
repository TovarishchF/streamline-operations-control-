"""Общие приспособления для тестов API.

Лежат в корне backend/, а не в tests/: приспособления из conftest
видны только своему каталогу и ниже, а нужны они и в accounts/tests,
и в catalog/tests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from rest_framework.test import APIClient

from accounts.models import Organization, Role, User
from counterparties.models import Client, Vendor
from tests.factories import PASSWORD

if TYPE_CHECKING:
    from collections.abc import Callable

@pytest.fixture
def organization(db: None) -> Organization:
    return Organization.objects.create(name="Стримлайн Група")


@pytest.fixture
def client_alpha(organization: Organization) -> Client:
    """Наименования контрагентов вымышлены (`CLAUDE.md § 4`)."""
    return Client.objects.create(organization=organization, name="Авиалинии Северного Ветра")


@pytest.fixture
def client_beta(organization: Organization) -> Client:
    return Client.objects.create(organization=organization, name="Полярная Авиакомпания")


@pytest.fixture
def vendor_alpha(organization: Organization) -> Vendor:
    return Vendor.objects.create(organization=organization, name="Топливная Компания Восток")


@pytest.fixture
def make_user(organization: Organization) -> Callable[..., User]:
    def factory(
        role: str,
        *,
        suffix: str = "1",
        client: Client | None = None,
        vendor: Vendor | None = None,
    ) -> User:
        user = User(
            username=f"{role}-{suffix}",
            email=f"{role}@example.test",
            first_name="Тест",
            last_name=role.capitalize(),
            role=role,
            organization=organization,
            client=client,
            vendor=vendor,
        )
        user.set_password(PASSWORD)
        user.save()
        return user

    return factory


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture
def as_role(api: APIClient, make_user: Callable[..., User]) -> Callable[..., APIClient]:
    """Аутентифицированный клиент для роли.

    Используется `force_authenticate`: проверяется поведение прав, а не
    разбор токена — за него отвечают отдельные тесты входа.
    """

    def login(role: str, **extra: object) -> APIClient:
        # Отдельный суффикс: в тесте рядом может быть пользователь той же роли,
        # созданный приспособлением, и логины столкнулись бы.
        extra.setdefault("suffix", "api")
        api.force_authenticate(user=make_user(role, **extra))
        return api

    return login


@pytest.fixture
def dispatcher(make_user: Callable[..., User]) -> User:
    return make_user(Role.DISPATCHER)
