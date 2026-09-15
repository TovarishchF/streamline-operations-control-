"""Фоновые задачи коммуникаций `[ТЗ 3.5.2, 3.2.2, 3.6.3]` (`BACKEND.md § 5`).

Задачи идемпотентны. Повторный запуск `send_outbox` не отправит письмо
дважды: отправленное уходит из выборки по статусу. Повторный `poll_inbox`
не заведёт второе входящее: письма сопоставляются по идентификатору
у источника.
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)

# Сколько сообщений берётся за один проход. Ограничение нужно, чтобы одна
# задача не заняла воркер на всю очередь: следующий проход через 30 секунд.
BATCH_SIZE = 50


@shared_task(name="comms.send_outbox")  # type: ignore[misc]
def send_outbox() -> int:
    """Отправляет то, чему пора уходить."""
    from comms.services import outbox

    processed = outbox.send_due(BATCH_SIZE)
    if processed:
        logger.info("исходящие: обработано %s сообщений", processed)
    return processed


@shared_task(name="comms.poll_inbox")  # type: ignore[misc]
def poll_inbox() -> int:
    """Забирает и разбирает входящие."""
    from comms.services import inbox

    created = inbox.poll(BATCH_SIZE)
    if created:
        logger.info("входящие: заведено %s писем", created)
    return created
