"""Внешние подключения для администратора `[ТЗ 4.2]` (ADR-039).

`/integrations`, `/integrations/{code}/test`, `/integrations/logs` — пути
и формы по `openapi.yaml`. Только для администратора: журнал обменов
содержит тела запросов к внешним системам.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import generics, serializers, status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Permission
from core.api.pagination import SocPagination
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from integrations import services
from integrations.base import IntegrationNotConfigured
from integrations.models import ExchangeStatus, IntegrationLog


class LocalizedNameSerializer(serializers.Serializer):  # type: ignore[type-arg]
    ru = serializers.CharField()
    en = serializers.CharField()


class IntegrationStatusSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`IntegrationStatus` из контракта."""

    code = serializers.CharField()
    name = LocalizedNameSerializer()
    healthy = serializers.BooleanField(allow_null=True)
    lastCheckAt = serializers.DateTimeField(allow_null=True)  # noqa: N815
    lastSuccessAt = serializers.DateTimeField(allow_null=True)  # noqa: N815


class IntegrationCheckResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`IntegrationCheckResult` из контракта."""

    code = serializers.CharField()
    success = serializers.BooleanField()
    durationMs = serializers.IntegerField()  # noqa: N815
    message = serializers.CharField(allow_blank=True)


class IntegrationLogEntrySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`IntegrationLogEntry` из контракта."""

    direction = serializers.SerializerMethodField()
    ts = serializers.DateTimeField(source="created_at")
    durationMs = serializers.IntegerField(source="duration_ms")  # noqa: N815
    success = serializers.SerializerMethodField()
    httpStatus = serializers.IntegerField(source="http_status", allow_null=True)  # noqa: N815
    error = serializers.SerializerMethodField()
    responseSizeBytes = serializers.IntegerField(source="response_bytes")  # noqa: N815
    relatedEntityType = serializers.SerializerMethodField()  # noqa: N815
    relatedEntityId = serializers.SerializerMethodField()  # noqa: N815

    class Meta:
        model = IntegrationLog
        fields = (
            "id", "code", "direction", "operation", "endpoint", "ts", "durationMs",
            "success", "httpStatus", "error", "responseSizeBytes",
            "relatedEntityType", "relatedEntityId",
        )

    def get_direction(self, obj: IntegrationLog) -> str:
        return services.direction(obj)

    def get_success(self, obj: IntegrationLog) -> bool:
        return obj.status == ExchangeStatus.OK

    def get_error(self, obj: IntegrationLog) -> str | None:
        return obj.error or None

    def get_relatedEntityType(self, obj: IntegrationLog) -> str | None:  # noqa: N802
        return obj.related_entity_type or None

    def get_relatedEntityId(self, obj: IntegrationLog) -> str | None:  # noqa: N802
        return obj.related_entity_id or None


class IntegrationListView(APIView):
    """`GET /api/v1/integrations` — работающие подключения."""

    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.ADMIN}

    @extend_schema(
        summary="Состояние внешних подключений",
        responses={200: IntegrationStatusSerializer(many=True)},
        tags=["admin"],
    )
    def get(self, request: Request) -> Response:
        return Response({"data": IntegrationStatusSerializer(services.statuses(), many=True).data})


class IntegrationCheckView(APIView):
    """`POST /api/v1/integrations/{code}/test`."""

    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"POST": Permission.ADMIN}

    @extend_schema(
        summary="Проверка подключения",
        request=None,
        responses={200: IntegrationCheckResultSerializer, 404: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request, code: str) -> Response:
        try:
            result = services.check(code)
        except IntegrationNotConfigured as error:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": str(error), "details": {"code": code}}},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(IntegrationCheckResultSerializer(result).data)


@extend_schema_view(
    get=extend_schema(summary="Журнал обменов с внешними системами", tags=["admin"]),
)
class IntegrationLogListView(generics.ListAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/integrations/logs`."""

    serializer_class = IntegrationLogEntrySerializer
    pagination_class = SocPagination
    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.ADMIN}

    def get_queryset(self) -> QuerySet[IntegrationLog]:
        return services.exchanges(self.request.query_params.get("code"))
