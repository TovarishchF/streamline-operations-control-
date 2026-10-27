"""Единый источник времени.

`CLAUDE.md § 3` п. 2: в доменном коде `datetime.now()` запрещён — только
`core.clock.now()`. Это правило существует по двум причинам:

1. Тесты должны управлять временем, не подменяя системные часы.
2. Режим генератора данных управляет модельным временем на сервере (ADR-014):
   клиентская перемотка ничего не даёт, потому что автопереходы выполняет Celery
   по серверным часам. Смещение применяется здесь, в одной точке, и автоматически
   действует на guard-ы, фоновые задачи и аудит.

Возвращаемое значение всегда осведомлено о зоне и всегда в UTC.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from django.conf import settings

if TYPE_CHECKING:
    from collections.abc import Iterator

_frozen: ContextVar[datetime | None] = ContextVar("clock_frozen", default=None)


@contextmanager
def frozen(moment: datetime) -> Iterator[None]:
    """Часы стоят на `moment` внутри блока.

    Генератор данных проводит прошедшие события через те же сервисы, что
    и человек: заказ за три дня до вылета, подтверждение через час, счёт
    после прилёта. Сервисы ставят метки по `now()`, и без остановки часов
    вся история набора случилась бы в одну секунду запуска генератора.

    `real_now()` не останавливается: журнал действий и обменов помнит,
    когда запись сделана на самом деле.
    """
    token = _frozen.set(moment)
    try:
        yield
    finally:
        _frozen.reset(token)


def _model_offset() -> timedelta:
    """Смещение модельного времени.

    Вне режима генератора данных — всегда ноль: обращения к базе за настройками
    не происходит, чтобы `now()` оставался дешёвым.
    """
    if not getattr(settings, "SAMPLE_DATA", False):
        return timedelta(0)

    from core.models import Settings  # локальный импорт: избегаем цикла при загрузке

    current = Settings.get_solo()
    offset = timedelta(seconds=current.clock_offset_seconds)
    if current.clock_scale > 1 and current.clock_anchor_at is not None:
        # Ускорение: с момента якоря модельное время идёт в `scale` раз
        # быстрее настоящего.
        offset += (datetime.now(UTC) - current.clock_anchor_at) * (current.clock_scale - 1)
    return offset


def now() -> datetime:
    """Текущее время в UTC с учётом модельного смещения."""
    moment = _frozen.get()
    if moment is not None:
        return moment
    return datetime.now(UTC) + _model_offset()


def real_now() -> datetime:
    """Настоящее время без смещения.

    Используется там, где подмена недопустима: метки аудита о реальном моменте
    действия, журнал обменов с внешними системами, замеры производительности.
    """
    return datetime.now(UTC)


def is_shifted() -> bool:
    """Включено ли модельное время. Уходит в ответ `/clock` и в записи аудита.

    Ускорение без смещения — тоже модельное время: уже через секунду
    часы стенда разойдутся с настоящими.
    """
    if not getattr(settings, "SAMPLE_DATA", False):
        return False
    from core.models import Settings

    current = Settings.get_solo()
    return bool(current.clock_offset_seconds != 0 or current.clock_scale > 1)


def today() -> datetime:
    """Начало текущих суток в UTC."""
    return now().replace(hour=0, minute=0, second=0, microsecond=0)
