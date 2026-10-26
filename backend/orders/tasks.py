"""Фоновые задачи заявок на услуги `[ТЗ 3.2.3]` (`BACKEND.md § 5`).

Задача идемпотентна: отмеченная заявка в следующий проход не попадает,
поэтому повторный запуск не заводит второе нарушение и второе уведомление.
"""

from __future__ import annotations

from celery import shared_task

from orders.services import sla


@shared_task(name="orders.check_sla")  # type: ignore[misc]
def check_sla() -> int:
    """Отмечает заявки, не подтверждённые поставщиком к сроку."""
    return sla.mark_overdue_confirmations()
