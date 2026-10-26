"""Фабрика адаптеров внешних систем `[ТЗ 4.2]`.

`INTEGRATIONS.md § 1`, `CLAUDE.md § 3` п. 4: доменный код обращается
к `get_provider()`, а не импортирует адаптер напрямую.

Заглушек нет (ADR-039). Подключение работает, если оно включено настройкой
`INTEGRATIONS_ENABLED` и для него написан адаптер; иначе система его
не вызывает, а функции, которые на нём держатся, недоступны. Выдавать
придуманные данные за ответ внешней системы нельзя, а молча подставлять
их — тем более.

Каждый вызов пишется в журнал обменов (`INTEGRATIONS § 7`).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from importlib import import_module
from importlib.util import find_spec
from typing import TYPE_CHECKING, Any

from django.conf import settings

from integrations.models import ExchangeStatus, IntegrationLog, IntegrationMode

if TYPE_CHECKING:
    from collections.abc import Callable


class IntegrationNotConfigured(Exception):
    """Подключение выключено либо адаптер для него не написан."""


# Назначение подключений для экрана администратора. Только те, для которых
# есть адаптер: остальные описаны в `docs/CONNECTING.md`.
NAMES: dict[str, dict[str, str]] = {
    "FX": {"ru": "Курсы валют ЦБ РФ", "en": "CBR exchange rates"},
    "SMTP": {"ru": "Исходящая почта", "en": "Outgoing mail"},
}


@dataclass
class Exchange:
    """Сведения об одном обмене, которые адаптер сообщает журналу."""

    operation: str
    endpoint: str = ""
    request_body: str = ""
    response_body: str = ""
    http_status: int | None = None
    response_bytes: int = 0
    related: tuple[str, str] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _module(code: str) -> str:
    return f"integrations.{code.lower()}.live"


def is_enabled(code: str) -> bool:
    """Подключение включено настройкой и для него есть адаптер."""
    if code.upper() not in settings.INTEGRATIONS_ENABLED:
        return False
    try:
        return find_spec(_module(code)) is not None
    except ModuleNotFoundError:
        # Нет даже пакета подключения — адаптер не написан
        return False


def enabled_codes() -> list[str]:
    """Работающие подключения в порядке настройки."""
    return [code for code in settings.INTEGRATIONS_ENABLED if is_enabled(code)]


def get_provider(code: str) -> Any:
    """Адаптер включённого подключения.

    Модуль ищется по соглашению `integrations.<код>.live`, класс —
    `Provider`. Соглашение вместо реестра: реестр забывают пополнить,
    а несуществующий модуль виден сразу.
    """
    if not is_enabled(code):
        raise IntegrationNotConfigured(
            f"подключение {code.upper()} не включено: см. docs/CONNECTING.md"
        )
    provider: Any = import_module(_module(code)).Provider()
    return provider


def record_exchange(
    code: str, call: Callable[[], tuple[Any, Exchange]], *, is_generated: bool = False
) -> Any:
    """Выполняет обмен и записывает его в журнал.

    Журналируется и успех, и отказ: отсутствие записи об ошибке — самая
    дорогая потеря при разборе спорной ситуации с поставщиком.
    """
    from core.models import DataSource

    started = time.perf_counter()
    try:
        result, exchange = call()
    except Exception as error:
        IntegrationLog.objects.create(
            code=code.upper(),
            mode=IntegrationMode.LIVE,
            operation=getattr(error, "operation", "unknown"),
            status=ExchangeStatus.ERROR,
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=f"{type(error).__name__}: {error}",
            is_generated=is_generated,
            data_source=DataSource.LIVE,
        )
        raise

    IntegrationLog.objects.create(
        code=code.upper(),
        mode=IntegrationMode.LIVE,
        operation=exchange.operation,
        endpoint=exchange.endpoint,
        status=ExchangeStatus.OK,
        http_status=exchange.http_status,
        duration_ms=int((time.perf_counter() - started) * 1000),
        response_bytes=exchange.response_bytes,
        request_body=exchange.request_body[:20_000],
        response_body=exchange.response_body[:20_000],
        related_entity_type=exchange.related[0] if exchange.related else "",
        related_entity_id=exchange.related[1] if exchange.related else "",
        is_generated=is_generated,
        data_source=DataSource.LIVE,
    )
    return result
