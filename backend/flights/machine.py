"""Чтение определения автомата рейса (ADR-015).

`shared/state-machines/flight.json` — источник истины для сервера и клиента
одновременно. Здесь он только читается: дублировать список переходов в коде
нельзя, два списка рано или поздно разъезжаются.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from django.conf import settings

MACHINE_PATH = Path(settings.SHARED_DIR) / "state-machines" / "flight.json"


@lru_cache(maxsize=1)
def definition() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(MACHINE_PATH.read_text(encoding="utf-8"))
    return payload


def transitions() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = definition()["transitions"]
    return items


def transition_by_name(name: str) -> dict[str, Any] | None:
    for item in transitions():
        if item["name"] == name:
            return dict(item)
    return None
