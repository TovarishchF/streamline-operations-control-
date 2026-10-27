"""Фоновые задачи по договорам `[ТЗ 3.3.3]` (`BACKEND.md § 5`).

Задача идемпотентна: напоминание по каждому порогу заводится один раз,
повторный запуск находит его по ключу и пропускает.
"""

from __future__ import annotations

from celery import shared_task

from counterparties.services import expiry


@shared_task(name="contracts.check_expiry")  # type: ignore[misc]
def check_expiry() -> int:
    """Напоминания об истечении договоров за 30, 15 и 7 дней."""
    return expiry.remind_expiring()
