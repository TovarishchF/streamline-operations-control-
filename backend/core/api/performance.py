"""Измеренные показатели производительности `[ТЗ 4.4]` (ADR-017).

`GET /performance` — перцентили за период по фактическим замерам, а не
декларация (`SPEC.md § 10.4`). `POST /performance/samples` — клиентские
замеры веб-клиента: время от навигации до отрисовки экрана.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, ClassVar

from django.db import connection
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Permission
from core import clock
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from core.models import PerformanceSample, PerformanceSource

# Нормативы ТЗ 4.4 (`SPEC.md § 10.4`). Клиентский замер карточки рейса
# сравнивается с тем же нормативом, что и серверный (ADR-017).
THRESHOLDS_MS = {"flight_card": 2000, "margin_calc": 5000}
DEFAULT_WINDOW = timedelta(days=7)
MAX_BATCH = 50


class SampleSerializer(serializers.Serializer):  # type: ignore[type-arg]
    name = serializers.ChoiceField(choices=sorted(THRESHOLDS_MS))
    durationMs = serializers.IntegerField(min_value=0, max_value=600_000)  # noqa: N815
    route = serializers.CharField(required=False, allow_blank=True, max_length=255, default="")
    kind = serializers.ChoiceField(
        choices=["initial_load", "navigation"], required=False, default="navigation"
    )


class SampleBatchSerializer(serializers.Serializer):  # type: ignore[type-arg]
    samples = serializers.ListField(child=SampleSerializer(), min_length=1, max_length=MAX_BATCH)


class PerformanceSamplesView(APIView):
    """`POST /api/v1/performance/samples`.

    Принимает замеры у любого вошедшего: экран открывают все роли, и замер
    без права на администрирование — та же правда о скорости системы.
    """

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        summary="Клиентские замеры производительности",
        tags=["admin"],
        request=SampleBatchSerializer,
        responses={
            202: inline_serializer(
                "PerformanceAccepted", fields={"accepted": serializers.IntegerField()}
            ),
            400: ErrorResponseSerializer,
        },
    )
    def post(self, request: Request) -> Response:
        payload = SampleBatchSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        moment = clock.real_now()
        samples = payload.validated_data["samples"]
        PerformanceSample.objects.bulk_create(
            PerformanceSample(
                name=item["name"],
                source=PerformanceSource.CLIENT,
                duration_ms=item["durationMs"],
                recorded_at=moment,
                route=item["route"],
                kind=item["kind"],
            )
            for item in samples
        )
        return Response({"accepted": len(samples)}, status=status.HTTP_202_ACCEPTED)


def _parse(raw: str | None, field: str) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise serializers.ValidationError({field: "Ожидается дата и время ISO 8601"}) from None


def report(since: datetime, until: datetime) -> list[dict[str, Any]]:
    """Перцентили по каждой метрике и источнику. Считает база, а не Python."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT name, source,
                   percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms),
                   percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms),
                   percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms),
                   count(*)
            FROM core_performancesample
            WHERE recorded_at >= %s AND recorded_at < %s
            GROUP BY name, source
            """,
            [since, until],
        )
        measured = {(row[0], row[1]): row[2:] for row in cursor.fetchall()}

    metrics = []
    for name, threshold in THRESHOLDS_MS.items():
        # Клиентский замер — у экрана карточки; расчёт маржи — серверная
        # операция, и клиентской метрики у него нет.
        sources = ("server", "client") if name == "flight_card" else ("server",)
        for source in sources:
            found = measured.get((name, source))
            p50, p95, p99, count = found if found else (None, None, None, 0)
            metrics.append(
                {
                    "name": name,
                    "source": source,
                    "p50Ms": p50,
                    "p95Ms": p95,
                    "p99Ms": p99,
                    "sampleCount": count,
                    "thresholdMs": threshold,
                    # Без замеров норматив не выполнен и не нарушен.
                    "withinThreshold": p95 <= threshold if p95 is not None else None,
                }
            )
    return metrics


class PerformanceReportView(APIView):
    """`GET /api/v1/performance`."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.ADMIN}

    @extend_schema(
        summary="Фактические показатели производительности",
        tags=["admin"],
        parameters=[
            OpenApiParameter("from", str, required=False),
            OpenApiParameter("to", str, required=False),
        ],
        responses={200: dict},
    )
    def get(self, request: Request) -> Response:
        until = _parse(request.query_params.get("to"), "to") or clock.real_now()
        since = _parse(request.query_params.get("from"), "from") or until - DEFAULT_WINDOW
        return Response(
            {"from": since.isoformat(), "to": until.isoformat(), "metrics": report(since, until)}
        )
