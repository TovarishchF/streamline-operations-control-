"""Системные эндпоинты: проверка работоспособности и время сервера."""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core import clock


def _check_database() -> dict[str, Any]:
    from time import perf_counter

    started = perf_counter()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return {"status": "down", "latencyMs": int((perf_counter() - started) * 1000)}
    return {"status": "ok", "latencyMs": int((perf_counter() - started) * 1000)}


def _check_cache() -> dict[str, Any]:
    from time import perf_counter

    started = perf_counter()
    try:
        cache.set("soc:health", "1", 10)
        ok = cache.get("soc:health") == "1"
    except Exception:
        ok = False
    return {
        "status": "ok" if ok else "down",
        "latencyMs": int((perf_counter() - started) * 1000),
    }


class HealthView(APIView):
    """`GET /api/v1/health`.

    Используется алертами (`INFRA.md § 5`) и для фиксации окончания восстановления
    при испытании из резервной копии (`TESTING.md § 6`).
    """

    permission_classes = (AllowAny,)
    authentication_classes = ()

    @extend_schema(
        summary="Проверка работоспособности",
        responses={200: dict, 503: dict},
        tags=["system"],
    )
    def get(self, request: Request) -> Response:
        checks = {"database": _check_database(), "cache": _check_cache()}
        healthy = all(check["status"] == "ok" for check in checks.values())
        payload = {
            "status": "ok" if healthy else "degraded",
            "version": getattr(settings, "RELEASE_VERSION", "1.0.0-draft"),
            "commit": getattr(settings, "RELEASE_COMMIT", "unknown"),
            "checks": checks,
        }
        return Response(
            payload,
            status=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
        )


class ClockView(APIView):
    """`GET /api/v1/clock`.

    Единственный источник времени для клиентов. Клиент экстраполирует значение
    между запросами, но не берёт время из системных часов браузера
    (`CLAUDE.md § 3` п. 2, ADR-014).
    """

    permission_classes = (IsAuthenticated,)

    @extend_schema(summary="Текущее время сервера", responses={200: dict}, tags=["system"])
    def get(self, request: Request) -> Response:
        from core.models import Settings

        scale = Settings.get_solo().clock_scale if settings.DEMO_DATA else 1
        return Response(
            {
                "nowUtc": clock.now().isoformat().replace("+00:00", "Z"),
                "shifted": clock.is_shifted(),
                "scale": scale,
            }
        )
