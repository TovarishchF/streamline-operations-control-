"""Общее для адаптеров курсов валют `[ТЗ 3.4.1]`."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class RateSet:
    """Курсы на дату. База — рубль (ADR-004).

    `rates[c]` — сколько рублей стоит **одна единица** валюты `c`. Номинал
    источника нормализован при загрузке: ЦБ РФ публикует японскую иену
    за сто единиц, и если это не привести к единице, счёт в иенах уедет
    в сто раз.
    """

    on_date: date
    rates: dict[str, Decimal]


class FxProvider(Protocol):
    def rates_on_date(self, on_date: date) -> RateSet: ...
