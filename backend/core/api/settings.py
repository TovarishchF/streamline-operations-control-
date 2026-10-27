"""Настройки системы `[ТЗ 4.3]` (`DOMAIN.md § 11`).

`GET/PATCH /settings` — форма по `openapi.yaml`. Значения проверяет
сервис (`core.services.settings`): сериализатор здесь описывает форму
для схемы и пропускает только объявленные поля.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from core.models import Settings
from core.services import settings as settings_service

FIELDS = (
    "lowMarginThresholdPercent",
    "defaultMarkupPercent",
    "documentNumberMasks",
    "fxPolicy",
    "slaWeights",
    "vendorSuggestWeights",
    "contractExpiryReminders",
    "deicingRule",
    "pdRetentionMonths",
    "clockOffsetSeconds",
    "clockScale",
)


class SettingsSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`Settings` из контракта."""

    lowMarginThresholdPercent = serializers.CharField(required=False)  # noqa: N815
    defaultMarkupPercent = serializers.CharField(required=False)  # noqa: N815
    documentNumberMasks = serializers.DictField(  # noqa: N815
        child=serializers.CharField(), required=False
    )
    fxPolicy = serializers.ChoiceField(  # noqa: N815
        choices=["document_date", "order_date"], required=False
    )
    slaWeights = serializers.DictField(child=serializers.CharField(), required=False)  # noqa: N815
    vendorSuggestWeights = serializers.DictField(  # noqa: N815
        child=serializers.CharField(), required=False
    )
    contractExpiryReminders = serializers.ListField(  # noqa: N815
        child=serializers.IntegerField(), required=False
    )
    deicingRule = serializers.DictField(  # noqa: N815
        child=serializers.IntegerField(), required=False
    )
    pdRetentionMonths = serializers.IntegerField(required=False)  # noqa: N815
    clockOffsetSeconds = serializers.IntegerField(required=False)  # noqa: N815
    clockScale = serializers.ChoiceField(choices=[1, 60, 600], required=False)  # noqa: N815
    sampleData = serializers.BooleanField(read_only=True)  # noqa: N815


class SettingsView(APIView):
    """`/api/v1/settings`: чтение и правка — у администратора."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "GET": Permission.ADMIN,
        "PATCH": Permission.ADMIN,
    }

    @extend_schema(summary="Настройки системы", tags=["admin"], responses={200: SettingsSerializer})
    def get(self, request: Request) -> Response:
        return Response(settings_service.to_contract(Settings.get_solo()))

    @extend_schema(
        summary="Изменение настроек",
        tags=["admin"],
        request=SettingsSerializer,
        responses={
            200: SettingsSerializer,
            400: ErrorResponseSerializer,
            403: ErrorResponseSerializer,
        },
    )
    def patch(self, request: Request) -> Response:
        payload = SettingsSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        # Значения берутся из исходного тела, а не из приведённых
        # сериализатором: десятичные проверяет сервис, и строка «12.5»
        # не должна по дороге стать числом с плавающей точкой.
        raw = request.data if isinstance(request.data, dict) else {}
        changes = {key: raw[key] for key in FIELDS if key in raw}
        updated = settings_service.update(changes=changes, actor=cast(User, request.user))
        return Response(settings_service.to_contract(updated))
