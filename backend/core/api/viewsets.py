"""Базовые вьюсеты.

`TenantScopedViewSet` — изоляция данных порталов (`BACKEND.md § 3.7`).
Фильтр стоит в `get_queryset()`, а не в проверке объекта: проверка объекта
закрывает только карточку, а списочный эндпоинт при этом отдаёт чужие записи.
Обращение к чужой записи даёт 404 — существование чужого рейса не раскрывается.

Отказ по умолчанию: если вьюсет доступен портальной роли, но не объявил,
по какому полю фильтровать, выборка пуста. Пустой список — заметная поломка,
которую починят; чужие данные в ответе никто не заметит.

Наборы действий собираются из примесей DRF поимённо, а не наследованием
`ModelViewSet`: тот заводит и создание, и удаление, а маршрут, которого нет
в `openapi.yaml`, валит проверку расхождения схемы. Контракт согласуется
с клиентами до кода (`CLAUDE.md § 3` п. 6).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

from rest_framework import mixins, viewsets

from accounts.models import Role
from accounts.permissions import TENANT_SCOPED_ROLES
from core.api.permissions import HasRolePermission

if TYPE_CHECKING:
    from collections.abc import Sequence

    from django.db.models import QuerySet


class SocViewSetMixin:
    """Общее для всех вьюсетов: проверка прав по карте ролей."""

    # Тип совпадает с объявлением в APIView: у DRF это последовательность
    # классов разрешений, а точное имя элемента в заглушках приватное.
    permission_classes: Sequence[Any] = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {}


class TenantScopedMixin:
    """Фильтрация выборки по арендатору для портальных ролей.

    `tenant_client_field` и `tenant_vendor_field` — путь к полю связи
    от модели вьюсета в терминах ORM: `operator_id`, `flight__client_id`.
    """

    tenant_client_field: ClassVar[str | None] = None
    tenant_vendor_field: ClassVar[str | None] = None

    def get_queryset(self) -> QuerySet[Any]:
        queryset: QuerySet[Any] = super().get_queryset()  # type: ignore[misc]
        user = self.request.user  # type: ignore[attr-defined]
        role = str(getattr(user, "role", ""))
        if role not in TENANT_SCOPED_ROLES:
            return queryset

        if role == Role.CLIENT:
            field, value = self.tenant_client_field, getattr(user, "client_id", None)
        else:
            field, value = self.tenant_vendor_field, getattr(user, "vendor_id", None)

        if field is None or value is None:
            return queryset.none()
        return queryset.filter(**{field: value})


class ReferenceViewSet(
    SocViewSetMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """Справочник: список для всех, у кого есть право на раздел."""


class TenantScopedViewSet(
    SocViewSetMixin,
    TenantScopedMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """Вьюсет с фильтрацией по арендатору. Действия добавляются примесями."""
