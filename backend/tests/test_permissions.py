"""Права на эндпоинтах `[ТЗ 4.3]`.

Критерий приёмки M3 сформулирован через рейсы: «под ролью «Финансист»
`POST /api/v1/flights` возвращает 403». Рейсы появляются на M4, поэтому
здесь проверяется тот же механизм на эндпоинтах, которые уже есть, и
отдельно — сама карта прав, по которой этот отказ и произойдёт.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from django.urls import reverse

from accounts.models import Role
from accounts.permissions import Permission, has_permission, permission_map

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

SERVICE_PAYLOAD = {
    "code": "HND_TEST",
    "category": "handling",
    "name": {"ru": "Проверочная услуга", "en": "Test service"},
    "unit": "flight",
}


class TestPermissionMap:
    """Карта прав — единый источник истины с клиентом (`BACKEND.md § 6`)."""

    def test_finance_cannot_create_flights(self) -> None:
        """Тот самый критерий приёмки, на уровне карты прав."""
        assert not has_permission(Role.FINANCE, Permission.FLIGHTS_WRITE)
        assert not has_permission(Role.FINANCE, Permission.FLIGHTS_STATUS)

    def test_dispatcher_cannot_change_prices(self) -> None:
        assert has_permission(Role.DISPATCHER, Permission.CATALOG_READ)
        assert not has_permission(Role.DISPATCHER, Permission.CATALOG_WRITE)

    def test_only_admin_and_manager_read_audit(self) -> None:
        allowed = {
            role for role in Role.values if has_permission(role, Permission.AUDIT_READ)
        }
        assert allowed == {Role.ADMIN, Role.MANAGER}

    def test_client_does_not_create_flights_directly(self) -> None:
        """`SPEC § 2.2`, сноска: клиент подаёт заявку, а не создаёт рейс."""
        assert not has_permission(Role.CLIENT, Permission.FLIGHTS_WRITE)
        assert has_permission(Role.CLIENT, Permission.FLIGHT_REQUESTS_CREATE)

    def test_map_lists_every_permission(self) -> None:
        """Клиент должен отличать «права нет» от «право неизвестно»."""
        assert set(permission_map(Role.CLIENT)) == set(Permission.values)

    def test_administrator_has_everything(self) -> None:
        assert all(permission_map(Role.ADMIN).values())


@pytest.mark.django_db
class TestEndpointPermissions:
    def test_dispatcher_cannot_add_a_service(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:service-list"),
            SERVICE_PAYLOAD,
            format="json",
            headers={"Idempotency-Key": "test-key-0001"},
        )

        assert response.status_code == 403
        assert response.data["error"]["code"] == "PERMISSION_DENIED"

    def test_finance_can_add_a_service(self, as_role: Callable[..., APIClient]) -> None:
        """Обратная проверка: отказ должен быть про право, а не про эндпоинт."""
        api = as_role(Role.FINANCE)

        response = api.post(
            reverse("v1:service-list"),
            SERVICE_PAYLOAD,
            format="json",
            headers={"Idempotency-Key": "test-key-0002"},
        )

        assert response.status_code == 201

    def test_finance_cannot_manage_users(self, as_role: Callable[..., APIClient]) -> None:
        api = as_role(Role.FINANCE)

        assert api.get(reverse("v1:user-list")).status_code == 403

    def test_dispatcher_cannot_read_audit(self, as_role: Callable[..., APIClient]) -> None:
        api = as_role(Role.DISPATCHER)

        assert api.get(reverse("v1:audit-list")).status_code == 403

    def test_manager_reads_audit(self, as_role: Callable[..., APIClient]) -> None:
        api = as_role(Role.MANAGER)

        assert api.get(reverse("v1:audit-list")).status_code == 200

    def test_anonymous_is_refused(self, api: APIClient) -> None:
        response = api.get(reverse("v1:airport-list"))

        assert response.status_code == 401
        assert response.data["error"]["code"] == "AUTHENTICATION_FAILED"
