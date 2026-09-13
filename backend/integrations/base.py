"""Фабрика адаптеров внешних систем `[ТЗ 4.2]`.

`INTEGRATIONS.md § 1`, `CLAUDE.md § 3` п. 4: доменный код обращается
к `get_provider()`, а не импортирует `live` или `stub` напрямую. Разница
между режимами не должна просачиваться в бизнес-логику — иначе переход
`stub → live` превращается в правку всех мест, где подключение используется.

Каждый вызов пишется в журнал обменов с **фактическим** режимом
(`INTEGRATIONS § 7`): по журналу всегда видно, откуда пришли данные.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from importlib import import_module
from typing import TYPE_CHECKING, Any

from django.conf import settings

from integrations.models import ExchangeStatus, IntegrationLog, IntegrationMode

if TYPE_CHECKING:
    from collections.abc import Callable


class IntegrationNotConfigured(Exception):
    """Адаптер для этого подключения ещё не написан."""


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


def mode_for(code: str) -> str:
    """Фактический режим подключения. Умолчание — `stub` (INTEGRATIONS § 1)."""
    return str(settings.INTEGRATION_MODES.get(code.upper(), IntegrationMode.STUB))


def get_provider(code: str) -> Any:
    """Возвращает адаптер подключения в том режиме, который задан настройкой.

    Модуль ищется по соглашению `integrations.<код>.<режим>`, класс —
    `Provider`. Соглашение вместо реестра: реестр забывают пополнить,
    а несуществующий модуль виден сразу.
    """
    normalized = code.lower()
    mode = mode_for(code)
    try:
        module = import_module(f"integrations.{normalized}.{mode}")
    except ModuleNotFoundError as error:
        raise IntegrationNotConfigured(
            f"адаптер {code} в режиме {mode} не реализован: {error}"
        ) from error
    provider: Any = module.Provider()
    return provider


def record_exchange(
    code: str, call: Callable[[], tuple[Any, Exchange]], *, is_demo: bool = False
) -> Any:
    """Выполняет обмен и записывает его в журнал.

    Журналируется и успех, и отказ: отсутствие записи об ошибке — самая
    дорогая потеря при разборе спорной ситуации с поставщиком.
    """
    from core.models import DataSource

    mode = mode_for(code)
    started = time.perf_counter()
    try:
        result, exchange = call()
    except Exception as error:
        IntegrationLog.objects.create(
            code=code.upper(),
            mode=mode,
            operation=getattr(error, "operation", "unknown"),
            status=ExchangeStatus.ERROR,
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=f"{type(error).__name__}: {error}",
            is_demo=is_demo,
            data_source=DataSource.LIVE if mode == IntegrationMode.LIVE else DataSource.SYNTHETIC,
        )
        raise

    IntegrationLog.objects.create(
        code=code.upper(),
        mode=mode,
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
        is_demo=is_demo,
        data_source=DataSource.LIVE if mode == IntegrationMode.LIVE else DataSource.SYNTHETIC,
    )
    return result
