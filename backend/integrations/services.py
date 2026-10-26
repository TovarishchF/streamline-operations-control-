"""Состояние внешних подключений и их проверка `[ТЗ 4.2]` (ADR-039).

Показываются только работающие подключения: включённые настройкой и имеющие
адаптер. Состояние берётся из журнала обменов, а не из настройки: включённое,
но недоступное подключение должно выглядеть недоступным.

Записи журнала, сделанные заглушками до ADR-039, не учитываются: настоящими
обменами они не были.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from integrations.base import NAMES, enabled_codes, get_provider, record_exchange
from integrations.models import ExchangeStatus, IntegrationLog, IntegrationMode

if TYPE_CHECKING:
    from django.db.models import QuerySet

# Подключения, которые приносят данные в систему, а не отправляют их наружу.
INBOUND = frozenset({"MAILBOT"})


def exchanges(code: str | None = None) -> QuerySet[IntegrationLog]:
    """Журнал настоящих обменов, новые сверху."""
    queryset = IntegrationLog.objects.filter(mode=IntegrationMode.LIVE)
    if code:
        queryset = queryset.filter(code=code.upper())
    return queryset.order_by("-created_at")


def statuses() -> list[dict[str, Any]]:
    """`IntegrationStatus` из контракта для каждого работающего подключения."""
    result: list[dict[str, Any]] = []
    for code in enabled_codes():
        last = exchanges(code).first()
        success = exchanges(code).filter(status=ExchangeStatus.OK).first()
        result.append(
            {
                "code": code,
                "name": NAMES.get(code, {"ru": code, "en": code}),
                "healthy": None if last is None else last.status == ExchangeStatus.OK,
                "lastCheckAt": last.created_at if last else None,
                "lastSuccessAt": success.created_at if success else None,
            }
        )
    return result


def check(code: str) -> dict[str, Any]:
    """Настоящее обращение к внешней системе без побочных действий.

    Отказ системы — не ошибка проверки, а её результат: он возвращается
    и попадает в журнал. Выключенное подключение — ошибка вызывающего
    (`IntegrationNotConfigured`).
    """
    provider = get_provider(code)
    started = time.perf_counter()
    try:
        record_exchange(code, provider.check)
    except Exception as error:  # отказ внешней системы и есть результат проверки
        message = f"{type(error).__name__}: {error}"
        success = False
    else:
        message = ""
        success = True
    return {
        "code": code.upper(),
        "success": success,
        "durationMs": int((time.perf_counter() - started) * 1000),
        "message": message,
    }


def direction(entry: IntegrationLog) -> str:
    return "inbound" if entry.code in INBOUND else "outbound"
