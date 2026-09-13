"""Журнал действий: чтение `[ТЗ 3.6.3]`.

`GET /api/v1/audit` по `openapi.yaml`. Только чтение: журнал пополняется
сервисом `audit.services.record`, а не через API.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import serializers

from accounts.permissions import Permission
from audit.models import AuditEntry
from core.api.viewsets import ReferenceViewSet


class AuditEntrySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    actorId = serializers.CharField(source="actor_id")  # noqa: N815
    actorName = serializers.CharField(source="actor_name")  # noqa: N815
    actorRole = serializers.CharField(source="actor_role")  # noqa: N815
    entityType = serializers.CharField(source="entity_type")  # noqa: N815
    entityId = serializers.CharField(source="entity_id")  # noqa: N815
    clockShifted = serializers.BooleanField(source="clock_shifted")  # noqa: N815

    class Meta:
        model = AuditEntry
        fields = (
            "id", "ts", "actorId", "actorName", "actorRole", "source",
            "entityType", "entityId", "action", "before", "after",
            "comment", "clockShifted",
        )


@extend_schema_view(list=extend_schema(summary="Журнал действий", tags=["admin"]))
class AuditViewSet(ReferenceViewSet):
    """`GET /api/v1/audit`. Доступен администратору и руководителю."""

    queryset = AuditEntry.objects.all()
    serializer_class = AuditEntrySerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.AUDIT_READ}

    def get_queryset(self) -> QuerySet[AuditEntry]:
        queryset = super().get_queryset()
        params = self.request.query_params

        for param, field in (
            ("entityType", "entity_type"),
            ("entityId", "entity_id"),
            ("actorId", "actor_id"),
            ("action", "action"),
        ):
            value = params.get(param)
            if value:
                queryset = queryset.filter(**{field: value})

        # Границы включительные с обеих сторон: диспетчер задаёт период
        # «с 1-го по 5-е» и ждёт, что 5-е попадёт.
        if params.get("from"):
            queryset = queryset.filter(ts__gte=params["from"])
        if params.get("to"):
            queryset = queryset.filter(ts__lte=params["to"])
        return queryset
