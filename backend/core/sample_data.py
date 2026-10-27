"""Режим генератора данных (ADR-008).

`SAMPLE_DATA=true` включает генератор (`seed_sample`, `/sample-data/*`)
и управление модельным временем (ADR-014). Записи, созданные генератором
или в этом режиме, несут `is_generated=True`: по признаку их удаляет
`seed_sample --purge`, не трогая введённое людьми.

В интерфейсе и выгрузках режим никак не обозначается: это рабочая
система, наполненная примерами, а не отдельный макет.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING

from django.conf import settings

if TYPE_CHECKING:
    from collections.abc import Iterator

_generating: ContextVar[bool] = ContextVar("sample_generating", default=False)


def enabled() -> bool:
    """Включён ли генератор данных."""
    return bool(settings.SAMPLE_DATA)


@contextmanager
def generating() -> Iterator[None]:
    """Всё, что создаётся внутри блока, — запись генератора.

    Генератор проводит события через те же сервисы, что и человек:
    заказ, подтверждение, счёт, сверку. Сервисы не знают, кто их вызвал,
    и поэтому признак ставится здесь, в одной точке, а не протаскивается
    параметром через каждую функцию:

    * новая запись получает `is_generated=True` и `data_source='synthetic'`
      (`core.models.BaseModel.save`);
    * запись журнала — `source='seed'` и автора «Система (генератор данных)»
      (`audit.services.record`): действие генератора не выдаётся за действие
      человека, даже если сервис получил пользователя;
    * письма и уведомления о прошедших событиях не рассылаются
      (`comms.services.events`): заявке, «заказанной» месяц назад,
      письмо сегодня не нужно.
    """
    token = _generating.set(True)
    try:
        yield
    finally:
        _generating.reset(token)


def is_generating() -> bool:
    """Идёт ли сейчас генерация набора."""
    return _generating.get()
