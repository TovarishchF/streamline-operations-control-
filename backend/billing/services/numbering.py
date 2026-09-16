"""Нумерация документов (`BACKEND.md § 3.5`).

Номер выдаётся `select_for_update()` внутри транзакции документа. Это даёт
сквозную нумерацию без дыр при параллельной работе.

Последовательность Postgres здесь не подошла бы: она пропускает значения
при откате транзакции, а дыра в нумерации счетов — это вопрос от налоговой.
Цена — сериализация выдачи номеров по типу документа и году; при десятках
счетов в день это не заметно.

Маска берётся из настроек системы: `SOC-I-{YYYY}-{NNNN}`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from billing.models import DocumentCounter
from core import clock
from core.models import Settings

if TYPE_CHECKING:
    from datetime import datetime

QUOTE = "quote"
INVOICE = "invoice"
PAYABLE = "payable"
# Сообщение координатору слота — не документ, но номер ему нужен той же
# природы: на него ссылаются в ответе, и дыра в нумерации мешает
# связать ответ с запросом (ADR-026).
SLOT = "slot"

MASK_FIELD = {
    QUOTE: "quote_number_mask",
    INVOICE: "invoice_number_mask",
    PAYABLE: "payable_number_mask",
    SLOT: "slot_message_mask",
}


def next_number(doc_type: str, *, at: datetime | None = None) -> str:
    """Следующий номер документа.

    Вызывается **внутри** транзакции документа: блокировка счётчика должна
    сниматься тогда же, когда документ становится видимым. Отдельная
    транзакция на номер оставила бы дыру при откате создания документа.
    """
    moment = at or clock.now()
    year = moment.year

    counter, _created = DocumentCounter.objects.get_or_create(doc_type=doc_type, year=year)
    # Блокировка строки счётчика: два одновременных выставления счёта
    # иначе получат один номер.
    locked = DocumentCounter.objects.select_for_update().get(pk=counter.pk)
    locked.last_number += 1
    locked.save(update_fields=["last_number"])

    mask = str(getattr(Settings.get_solo(), MASK_FIELD[doc_type]))
    return mask.replace("{YYYY}", str(year)).replace(
        "{NNNN}", str(locked.last_number).zfill(4)
    )
