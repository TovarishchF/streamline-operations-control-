"""Серверные замеры нормативов ТЗ 4.4 (ADR-017).

Посредник измеряет время ответа двух эндпоинтов, для которых ТЗ задаёт
норматив, — карточки рейса и расчёта маржи — и пишет замер в базу.
`/admin/performance` показывает перцентили по этим замерам.

Замер не должен ломать ответ: ошибка записи замера пишется в журнал,
а пользователь получает свой ответ как ни в чём не бывало.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from rest_framework import status

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.http import HttpRequest, HttpResponse

logger = logging.getLogger(__name__)

# Имя маршрута → метрика. Только GET: правка рейса — не открытие карточки.
MEASURED = {"flight-detail": "flight_card", "flight-margin": "margin_calc"}


class PerformanceMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        started = time.perf_counter()
        response = self.get_response(request)
        match = getattr(request, "resolver_match", None)
        name = MEASURED.get(match.url_name or "") if match is not None else None
        if name and request.method == "GET" and response.status_code == status.HTTP_200_OK:
            self._record(name, request.path, int((time.perf_counter() - started) * 1000))
        return response

    @staticmethod
    def _record(name: str, path: str, duration_ms: int) -> None:
        from core import clock
        from core.models import PerformanceSample, PerformanceSource

        try:
            PerformanceSample.objects.create(
                name=name,
                source=PerformanceSource.SERVER,
                duration_ms=duration_ms,
                recorded_at=clock.real_now(),
                route=path[:255],
            )
        except Exception:
            # Замер — не повод отказать в ответе: причина остаётся в журнале.
            logger.exception("замер производительности %s не записан", name)
