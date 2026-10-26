"""Финансовые эндпоинты: курсы валют `[ТЗ 3.4.1]`, маржа рейса `[ТЗ 3.4.3]`."""

from __future__ import annotations

from datetime import date
from typing import Any, ClassVar

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Permission, has_permission
from billing.services import fx
from billing.services import margin as margin_service
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer


class FxSnapshotSerializer(serializers.Serializer):  # type: ignore[type-arg]
    # `date` и `source` совпадают по имени с атрибутами базового класса
    # сериализатора, поэтому объявляются через словарь полей: имена в ответе
    # заданы контрактом и подстраивать их под внутреннее устройство нельзя.
    base = serializers.CharField()
    rates = serializers.DictField(child=serializers.CharField())
    policy = serializers.CharField()
    staleSince = serializers.DateTimeField(allow_null=True, required=False)  # noqa: N815

    def get_fields(self) -> dict[str, serializers.Field]:  # type: ignore[type-arg]
        fields = super().get_fields()
        fields["date"] = serializers.DateTimeField()
        fields["source"] = serializers.CharField(required=False)
        return fields


class FxRatesView(APIView):
    """`GET /api/v1/fx-rates`.

    База — рубль (ADR-004). Если курса на запрошенную дату нет, отдаётся
    последний известный с отметкой `staleSince`: расчёт по устаревшему курсу
    допустим, а молчание о том, что он устаревший, — нет.
    """

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        summary="Курсы валют",
        responses={200: FxSnapshotSerializer, 403: ErrorResponseSerializer},
        tags=["billing"],
    )
    def get(self, request: Request) -> Response:
        role = str(getattr(request.user, "role", ""))
        if not has_permission(role, Permission.BILLING_DOCUMENTS_VIEW):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied

        raw = request.query_params.get("onDate")
        on_date: date | None = None
        if raw:
            try:
                on_date = date.fromisoformat(raw)
            except ValueError:
                raise serializers.ValidationError(
                    {"onDate": "Ожидается дата в виде ГГГГ-ММ-ДД"}
                ) from None

        payload: dict[str, Any] = fx.snapshot(on_date)

        since = request.query_params.get("from")
        if since:
            try:
                start = date.fromisoformat(since)
            except ValueError:
                raise serializers.ValidationError(
                    {"from": "Ожидается дата в виде ГГГГ-ММ-ДД"}
                ) from None
            payload["history"] = fx.history(start, on_date or date.fromisoformat(payload["date"]))

        return Response(payload)


class MarginResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`MarginResult` из контракта."""

    mode = serializers.ChoiceField(choices=list(margin_service.MODES))
    currency = serializers.CharField()
    revenue = serializers.DictField(child=serializers.CharField())
    cost = serializers.DictField(child=serializers.CharField())
    margin = serializers.DictField(child=serializers.CharField())
    marginPercent = serializers.CharField(allow_null=True)  # noqa: N815
    planPortionPercent = serializers.CharField(allow_null=True)  # noqa: N815
    isBelowThreshold = serializers.BooleanField()  # noqa: N815
    thresholdPercent = serializers.CharField()  # noqa: N815
    fx = FxSnapshotSerializer()
    calculatedAt = serializers.DateTimeField()  # noqa: N815


class FlightMarginView(APIView):
    """`GET /api/v1/flights/{id}/margin` `[ТЗ 3.4.3]`.

    Норматив расчёта — 5 секунд (`ТЗ 4.4`); расчёт кэшируется и сбрасывается
    при изменении заявок, счетов и тарифов клиента. Маржа — не для порталов:
    клиент и поставщик права на неё не имеют.
    """

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.BILLING_MARGIN_VIEW}

    @extend_schema(
        summary="Маржинальность рейса",
        parameters=[
            OpenApiParameter("mode", str, enum=list(margin_service.MODES), required=False),
        ],
        responses={
            200: MarginResultSerializer,
            404: ErrorResponseSerializer,
            503: ErrorResponseSerializer,
        },
        tags=["billing"],
    )
    def get(self, request: Request, pk: str) -> Response:
        from flights.models import Flight

        mode = request.query_params.get("mode", "mixed")
        if mode not in margin_service.MODES:
            raise serializers.ValidationError(
                {"mode": f"Режим расчёта: {', '.join(margin_service.MODES)}"}
            )
        flight = get_object_or_404(Flight, pk=pk)
        return Response(margin_service.cached(flight, mode))
