"""Управление демонстрационным набором `[ТЗ этап 2]` (ADR-008, ADR-016).

Генерация и очистка живут в команде `seed_demo`: она была первой, и весь
набор описан там. Здесь — тонкая обёртка, через которую те же действия
вызываются из интерфейса администратора.

Обёртка, а не вторая реализация: набор, собранный командой, и набор,
собранный кнопкой, обязаны совпадать — иначе стенд после нажатия кнопки
переставал бы соответствовать тому, что показывали заказчику.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.conf import settings

from core.exceptions import DemoOnlyOperation

if TYPE_CHECKING:
    from demo.management.commands.seed_demo import Command

SEED = "seed"
RESET = "reset"
PURGE = "purge"

DEFAULT_SEED = 20260913


def _command() -> Command:
    from demo.management.commands.seed_demo import Command

    return Command()


def _require_demo_mode() -> None:
    """Отказ в боевом режиме.

    Проверка повторяет ту, что стоит в команде, и это не дублирование:
    эндпоинт и команда — два разных входа, и закрыт должен быть каждый
    (`CLAUDE.md § 4`).
    """
    if not settings.DEMO_DATA:
        raise DemoOnlyOperation(
            "Управление демонстрационными данными доступно только при "
            "DEMO_DATA=true: в боевом режиме придуманные контрагенты "
            "в базе недопустимы (ADR-008)"
        )


def generate(seed: int = DEFAULT_SEED) -> dict[str, int]:
    """Дополняет набор. Существующие записи не трогает."""
    _require_demo_mode()
    return _command().generate(seed)


def purge() -> dict[str, int]:
    """Удаляет только записи с `is_demo` (ADR-016)."""
    _require_demo_mode()
    return _command().purge()


def reset(seed: int = DEFAULT_SEED) -> dict[str, int]:
    """Пересоздаёт набор: очистка и генерация заново.

    Числа возвращаются от генерации: администратора интересует, что теперь
    на стенде, а не сколько записей исчезло по дороге.
    """
    purge()
    return generate(seed)
