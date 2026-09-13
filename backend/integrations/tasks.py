"""Фоновые задачи подключений `[ТЗ 4.2]` (`BACKEND.md § 5`).

Задачи идемпотентны и переживают повторный запуск: расписание может
сработать дважды, а курс за один день должен остаться один.
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


# Декоратор Celery не типизирован: аннотация задачи сохраняется явно.
@shared_task(name="fx.sync_rates")  # type: ignore[misc]
def sync_fx_rates() -> int:
    """Загрузка курсов валют. Расписание — 06:00 UTC (`BACKEND.md § 5`)."""
    from billing.services import fx

    written = fx.sync_rates()
    logger.info("курсы валют обновлены", extra={"rates": written})
    return written
