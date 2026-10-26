"""Режим генератора данных (ADR-008).

`SAMPLE_DATA=true` включает генератор (`seed_sample`, `/sample-data/*`)
и управление модельным временем (ADR-014). Записи, созданные генератором
или в этом режиме, несут `is_generated=True`: по признаку их удаляет
`seed_sample --purge`, не трогая введённое людьми.

В интерфейсе и выгрузках режим никак не обозначается: это рабочая
система, наполненная примерами, а не отдельный макет.
"""

from __future__ import annotations

from django.conf import settings


def enabled() -> bool:
    """Включён ли генератор данных."""
    return bool(settings.SAMPLE_DATA)
