"""Управление набором данных генератора `[ТЗ этап 2]` (ADR-008, ADR-016).

Генерация и очистка живут в команде `seed_sample`: она была первой, и весь
набор описан там. Здесь — тонкая обёртка, через которую те же действия
вызываются из интерфейса администратора.

Обёртка, а не вторая реализация: набор, собранный командой, и набор,
собранный кнопкой, обязаны совпадать — иначе после нажатия кнопки система
переставала бы соответствовать тому, что показывали заказчику.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from core import sample_data
from core.exceptions import SampleDataDisabled

if TYPE_CHECKING:
    from sampledata.management.commands.seed_sample import Command

GENERATE = "generate"
RESET = "reset"
PURGE = "purge"

DEFAULT_SEED = 20260913


def _command() -> Command:
    from sampledata.management.commands.seed_sample import Command

    return Command()


def _require_sample_data() -> None:
    """Отказ при выключенном генераторе.

    Проверка повторяет ту, что стоит в команде, и это не дублирование:
    эндпоинт и команда — два разных входа, и закрыт должен быть каждый
    (`CLAUDE.md § 4`).
    """
    if not sample_data.enabled():
        raise SampleDataDisabled(
            "Генератор данных доступен только при SAMPLE_DATA=true: в рабочей "
            "базе придуманные контрагенты недопустимы (ADR-008)"
        )


def generate(seed: int = DEFAULT_SEED) -> dict[str, int]:
    """Дополняет набор. Существующие записи не трогает."""
    _require_sample_data()
    return _command().generate(seed)


def purge() -> dict[str, int]:
    """Удаляет только записи с `is_generated` (ADR-016)."""
    _require_sample_data()
    return _command().purge()


def reset(seed: int = DEFAULT_SEED) -> dict[str, int]:
    """Пересоздаёт набор: очистка и генерация заново.

    Числа возвращаются от генерации: администратора интересует, что теперь
    в системе, а не сколько записей исчезло по дороге.
    """
    purge()
    return generate(seed)
