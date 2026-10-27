"""Дашборды диспетчера и руководителя `[ТЗ 3.6.2]` (`SPEC.md § 9.2`).

`/dashboards/{role}`, `/dashboards/{role}/layout` — пути и формы по
`openapi.yaml`. Раскладка виджетов сохраняется на пользователя.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission, has_permission
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from reports.services import dashboards

ROLE_PERMISSIONS = {
    "dispatcher": Permission.DASHBOARD_DISPATCHER,
    "manager": Permission.DASHBOARD_MANAGER,
}


class LayoutItemSerializer(serializers.Serializer):  # type: ignore[type-arg]
    code = serializers.CharField()
    x = serializers.IntegerField(min_value=0)
    y = serializers.IntegerField(min_value=0)
    w = serializers.IntegerField(min_value=1, max_value=dashboards.GRID_COLUMNS)
    h = serializers.IntegerField(min_value=1, max_value=24)


class DashboardLayoutSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`DashboardLayout` из контракта."""

    widgets = LayoutItemSerializer(many=True)


class DashboardWidgetSerializer(serializers.Serializer):  # type: ignore[type-arg]
    code = serializers.CharField()
    title = serializers.DictField(child=serializers.CharField())

    def get_fields(self) -> dict[str, serializers.Field]:  # type: ignore[type-arg]
        # `data` совпадает с атрибутом сериализатора, поэтому объявляется
        # через словарь полей: имя задано контрактом.
        fields = super().get_fields()
        fields["data"] = serializers.DictField()
        return fields


class DashboardDataSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`DashboardData` из контракта."""

    widgets = DashboardWidgetSerializer(many=True)
    generatedAt = serializers.DateTimeField(allow_null=True)  # noqa: N815
    layout = DashboardLayoutSerializer()


def _check(request: Request, role: str) -> None:
    permission = ROLE_PERMISSIONS.get(role)
    if permission is None:
        raise Http404
    if not has_permission(str(getattr(request.user, "role", "")), permission):
        raise PermissionDenied


class DashboardView(APIView):
    """`GET /api/v1/dashboards/{role}`."""

    permission_classes = (HasRolePermission,)
    # Право на конкретный дашборд проверяется в самом действии: роль
    # в пути, а не в имени эндпоинта.
    required_permissions: ClassVar[dict[str, Any]] = {
        "GET": (Permission.DASHBOARD_DISPATCHER, Permission.DASHBOARD_MANAGER)
    }

    @extend_schema(
        summary="Данные дашборда",
        tags=["reports"],
        responses={200: DashboardDataSerializer, 404: ErrorResponseSerializer},
    )
    def get(self, request: Request, role: str) -> Response:
        _check(request, role)
        return Response(dashboards.data_for(cast(User, request.user), role))


class DashboardLayoutView(APIView):
    """`PUT /api/v1/dashboards/{role}/layout`."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "PUT": (Permission.DASHBOARD_DISPATCHER, Permission.DASHBOARD_MANAGER)
    }

    @extend_schema(
        summary="Сохранение раскладки виджетов на пользователя",
        tags=["reports"],
        request=DashboardLayoutSerializer,
        responses={200: DashboardLayoutSerializer, 400: ErrorResponseSerializer},
    )
    def put(self, request: Request, role: str) -> Response:
        _check(request, role)
        payload = DashboardLayoutSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        saved = dashboards.save_layout(
            cast(User, request.user), role, payload.validated_data["widgets"]
        )
        return Response({"widgets": saved})
