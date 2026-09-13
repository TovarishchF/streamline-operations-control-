"""Эндпоинты парка воздушных судов `[ТЗ 3.1.3]`.

`/fleet` и `/fleet/{id}` по `openapi.yaml`.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins
from rest_framework.serializers import BaseSerializer

from accounts.permissions import Permission
from audit import services as audit
from audit.models import AuditEntityType
from core.api.viewsets import TenantScopedViewSet
from fleet.api.serializers import AircraftSerializer, AircraftUpdateSerializer
from fleet.models import Aircraft


@extend_schema_view(
    list=extend_schema(summary="Парк воздушных судов", tags=["fleet"]),
    retrieve=extend_schema(summary="Воздушное судно", tags=["fleet"]),
    partial_update=extend_schema(summary="Изменить состояние борта", tags=["fleet"]),
)
class AircraftViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/fleet`.

    Клиент видит только свои борта: `operator` — это он. Для поставщика
    поле связи не объявлено, и по умолчанию выборка для него пуста —
    парк клиента поставщика не касается.
    """

    # Контракт объявляет только частичное изменение: PUT потребовал бы
    # присылать запись целиком, а маршрута под него в openapi.yaml нет.
    http_method_names = ["get", "patch", "head", "options"]  # noqa: RUF012
    queryset = Aircraft.objects.select_related("type", "operator").prefetch_related("approvals")
    serializer_class = AircraftSerializer
    tenant_client_field = "operator_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.FLIGHTS_READ,
        "retrieve": Permission.FLIGHTS_READ,
        "update": Permission.FLIGHTS_WRITE,
        "partial_update": Permission.FLIGHTS_WRITE,
    }

    def get_queryset(self) -> QuerySet[Aircraft]:
        queryset = super().get_queryset()
        status = self.request.query_params.get("status")
        if status:
            queryset = queryset.filter(status=status)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Aircraft]]:
        if self.action in ("update", "partial_update"):
            return AircraftUpdateSerializer
        return AircraftSerializer

    def perform_update(self, serializer: BaseSerializer[Aircraft]) -> None:
        instance = serializer.instance
        assert isinstance(instance, Aircraft)
        before = audit.snapshot(instance)
        aircraft = serializer.save()
        audit.record(
            entity_type=AuditEntityType.AIRCRAFT,
            entity_id=aircraft.pk,
            action="updated",
            actor=self.request.user,  # type: ignore[arg-type]
            before=before,
            after=audit.snapshot(aircraft),
        )
