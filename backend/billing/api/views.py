"""Финансовые эндпоинты. На этой вехе — курсы валют `[ТЗ 3.4.1]`."""

from __future__ import annotations

from datetime import date
from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Permission, has_permission
from billing.services import fx
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
