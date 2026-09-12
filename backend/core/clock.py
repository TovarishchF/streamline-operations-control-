"""Единый источник времени.

`CLAUDE.md § 3` п. 2: в доменном коде `datetime.now()` запрещён — только
`core.clock.now()`. Это правило существует по двум причинам:

1. Тесты должны управлять временем, не подменяя системные часы.
2. Демонстрационный стенд управляет модельным временем на сервере (ADR-014):
   клиентская перемотка ничего не даёт, потому что автопереходы выполняет Celery
   по серверным часам. Смещение применяется здесь, в одной точке, и автоматически
   действует на guard-ы, фоновые задачи и аудит.

Возвращаемое значение всегда осведомлено о зоне и всегда в UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.conf import settings


def _demo_offset() -> timedelta:
    """Смещение модельного времени.

    Вне демонстрационного режима — всегда ноль: обращения к базе за настройками
    не происходит, чтобы `now()` оставался дешёвым.
    """
    if not getattr(settings, "DEMO_DATA", False):
        return timedelta(0)

    from core.models import Settings  # локальный импорт: избегаем цикла при загрузке

    return timedelta(seconds=Settings.get_solo().clock_offset_seconds)


def now() -> datetime:
    """Текущее время в UTC с учётом модельного смещения."""
    return datetime.now(UTC) + _demo_offset()


def real_now() -> datetime:
    """Настоящее время без смещения.

    Используется там, где подмена недопустима: метки аудита о реальном моменте
    действия, журнал обменов с внешними системами, замеры производительности.
    """
    return datetime.now(UTC)


def is_shifted() -> bool:
    """Включено ли модельное время. Уходит в ответ `/clock` и в записи аудита."""
    return _demo_offset() != timedelta(0)


def today() -> datetime:
    """Начало текущих суток в UTC."""
    return now().replace(hour=0, minute=0, second=0, microsecond=0)
