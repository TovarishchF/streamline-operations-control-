"""Заглушка курсов валют `[ТЗ 3.4.1]` (`INTEGRATIONS.md § 2.1`).

Случайное блуждание ±0.4 % в день от базовых значений; выходные повторяют
пятницу — так же, как ведёт себя настоящий источник.

Числа детерминированы по дате: один и тот же день даёт один и тот же курс
при каждом обращении. Иначе стенд «дрожал» бы между обновлениями страницы,
а сверить расчёт маржи с показанным курсом было бы нельзя.

Данные заглушки получают происхождение `synthetic`, а не `live`
(`CLAUDE.md § 4`): подставной курс не выдаётся за курс ЦБ.
"""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings

from integrations.base import Exchange
from integrations.fx.base import RateSet

# Порядок величин на начало 2026 года. Точность здесь не нужна и вредна:
# заглушка не должна выглядеть настоящим курсом.
BASE_RATES = {
    "USD": Decimal("92.00"),
    "EUR": Decimal("100.00"),
}

DAILY_DRIFT = Decimal("0.004")  # ±0.4 % в день
SATURDAY = 5


class Provider:
    """Детерминированная заглушка курсов."""

    code = "FX"

    def rates_on_date(self, on_date: date) -> tuple[RateSet, Exchange]:
        effective = self._last_business_day(on_date)
        base = str(settings.FX_BASE_CURRENCY)

        rates: dict[str, Decimal] = {base: Decimal(1)}
        for code in settings.SUPPORTED_CURRENCIES:
            if code == base:
                continue
            anchor = BASE_RATES.get(code, Decimal("50.00"))
            rates[code] = (anchor * (Decimal(1) + self._drift(code, effective))).quantize(
                Decimal("0.0001")
            )

        return (
            RateSet(on_date=effective, rates=rates),
            Exchange(
                operation="rates_on_date",
                endpoint="stub://fx",
                response_body=str({code: str(value) for code, value in rates.items()}),
            ),
        )

    def _last_business_day(self, on_date: date) -> date:
        """Выходные повторяют пятницу — как и у настоящего источника."""
        shifted = on_date
        while shifted.weekday() >= SATURDAY:
            shifted -= timedelta(days=1)
        return shifted

    def _drift(self, code: str, on_date: date) -> Decimal:
        """Отклонение от базового значения, детерминированное по дате.

        Хэш вместо генератора случайных чисел: не зависит ни от порядка
        вызовов, ни от состояния процесса.
        """
        digest = hashlib.sha256(f"{code}:{on_date:%Y-%m-%d}".encode()).digest()
        # Два байта дают шаг в 1/65535 диапазона: достаточно мелко,
        # чтобы соседние дни отличались, и достаточно грубо, чтобы
        # курс оставался читаемым.
        position = Decimal(int.from_bytes(digest[:2], "big")) / Decimal(65535)
        return (position * 2 - 1) * DAILY_DRIFT * Decimal(30)
