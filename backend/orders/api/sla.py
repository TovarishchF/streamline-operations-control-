"""Справочник правил SLA `[ТЗ 3.2.3]` (`DOMAIN.md § 7.6`, G-39).

`/sla-rules` — пути и формы по `openapi.yaml`. Правила не правятся
и не удаляются: новое правило на ту же область вытесняет прежнее
(`orders.services.sla.create_rule`), поэтому в контракте только
чтение и добавление.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, ClassVar, cast

from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from catalog.models import ServiceCategory
from core.api.idempotency import IdempotencyMixin
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from counterparties.models import Vendor
from orders.models import SlaPenaltyKind, SlaRule
from orders.services import sla


class SlaScopeSerializer(serializers.Serializer):  # type: ignore[type-arg]
    category = serializers.ChoiceField(
        choices=ServiceCategory.choices, allow_null=True, required=False, default=None
    )
    vendorId = serializers.CharField(allow_null=True, required=False, default=None)  # noqa: N815

    def validate_vendorId(self, value: str | None) -> str | None:  # noqa: N802
        if value and not Vendor.objects.filter(pk=value).exists():
            raise serializers.ValidationError("Поставщик не найден")
        return value or None


class SlaPenaltySerializer(serializers.Serializer):  # type: ignore[type-arg]
    kind = serializers.ChoiceField(choices=SlaPenaltyKind.choices, default=SlaPenaltyKind.NONE)
    value = serializers.DecimalField(
        max_digits=18,
        decimal_places=4,
        coerce_to_string=True,
        allow_null=True,
        required=False,
        default=None,
    )

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["kind"] != SlaPenaltyKind.NONE and not (attrs.get("value") or Decimal(0)) > 0:
            raise serializers.ValidationError({"value": "У штрафа обязан быть размер больше нуля"})
        if attrs["kind"] == SlaPenaltyKind.PERCENT and attrs["value"] > Decimal(100):
            raise serializers.ValidationError({"value": "Процент штрафа не больше 100"})
        return attrs


class SlaRuleSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`SlaRule` из контракта."""

    id = serializers.CharField(read_only=True)
    scope = SlaScopeSerializer()
    confirmMinutes = serializers.IntegerField(min_value=1)  # noqa: N815
    completionMinutes = serializers.IntegerField(  # noqa: N815
        min_value=1, allow_null=True, required=False, default=None
    )
    penalty = SlaPenaltySerializer(required=False)

    def to_representation(self, instance: SlaRule) -> dict[str, Any]:
        return {
            "id": instance.pk,
            "scope": {"category": instance.category or None, "vendorId": instance.vendor_id},
            "confirmMinutes": instance.confirm_minutes,
            "completionMinutes": instance.completion_minutes,
            "penalty": {
                "kind": instance.penalty_kind,
                "value": str(instance.penalty_value) if instance.penalty_value else None,
            },
        }


class SlaRuleListView(IdempotencyMixin, APIView):
    """`/api/v1/sla-rules`: действующие правила и добавление нового."""

    permission_classes = (HasRolePermission,)
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        # Поставщики и их сроки — одна тема: правила видит тот, кто видит
        # реестр поставщиков, а меняет только администратор (`/admin/sla`).
        "GET": (Permission.ADMIN, Permission.VENDOR_VIEW),
        "POST": Permission.ADMIN,
    }

    @extend_schema(
        summary="Правила SLA",
        tags=["admin"],
        responses={
            200: inline_serializer(
                "SlaRuleList", fields={"data": SlaRuleSerializer(many=True)}
            )
        },
    )
    def get(self, request: Request) -> Response:
        rules = SlaRule.objects.filter(superseded_at__isnull=True).order_by(
            "vendor__name", "category"
        )
        return Response({"data": SlaRuleSerializer(rules, many=True).data})

    @extend_schema(
        summary="Добавление правила SLA",
        tags=["admin"],
        request=SlaRuleSerializer,
        responses={201: SlaRuleSerializer, 400: ErrorResponseSerializer},
    )
    def post(self, request: Request) -> Response:
        def produce() -> Response:
            payload = SlaRuleSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            penalty = data.get("penalty") or {"kind": SlaPenaltyKind.NONE, "value": None}
            rule = sla.create_rule(
                category=data["scope"].get("category") or "",
                vendor_id=data["scope"].get("vendorId"),
                confirm_minutes=data["confirmMinutes"],
                completion_minutes=data.get("completionMinutes"),
                penalty_kind=penalty["kind"],
                penalty_value=penalty.get("value"),
                actor=cast(User, request.user),
            )
            return Response(SlaRuleSerializer(rule).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)
