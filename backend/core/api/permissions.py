"""Проверка прав на эндпоинте `[ТЗ 4.3]`.

`BACKEND.md § 6`: класс на каждый эндпоинт, карта `роль → право` —
единый источник истины с фронтендом. Карта живёт в `accounts.permissions`,
здесь она только применяется.

Эндпоинт объявляет требуемое право словарём `required_permissions`.
Ключ — действие вьюсета (`list`, `create`, …) либо метод HTTP для обычной
вьюхи; `"default"` покрывает остальное. Действие без объявленного права
запрещено: умолчание «разрешено» рано или поздно открывает эндпоинт,
про который забыли.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rest_framework.permissions import BasePermission

from accounts.permissions import has_permission

if TYPE_CHECKING:
    from rest_framework.request import Request
    from rest_framework.views import APIView

# Действия, которые считаются чтением, если вьюха объявила права
# только для чтения и записи.
READ_ACTIONS = frozenset({"list", "retrieve", "GET", "HEAD", "OPTIONS"})


class HasRolePermission(BasePermission):
    """Пропускает, если роль пользователя обладает объявленным правом."""

    message = "Недостаточно прав для этого действия"

    def has_permission(self, request: Request, view: APIView) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False

        required = self._required_for(request, view)
        if required is None:
            # Право не объявлено — значит эндпоинт не продуман. Отказ
            # заметят сразу, молчаливое разрешение — через полгода.
            return False
        return has_permission(str(getattr(user, "role", "")), required)

    def _required_for(self, request: Request, view: APIView) -> str | None:
        declared: dict[str, Any] = getattr(view, "required_permissions", {})
        if not declared:
            return None
        action = getattr(view, "action", None) or request.method or ""
        if action in declared:
            return str(declared[action])
        if "default" in declared:
            return str(declared["default"])
        return None
