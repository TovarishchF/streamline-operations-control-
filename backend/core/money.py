"""Денежная арифметика.

Единственный допустимый способ работать с деньгами в системе.
Правило округления — ADR-002, отменяет частные формулировки в `CLAUDE.md § 3`,
`DOMAIN.md § 1` и `DOMAIN.md § 7.1`:

1. Промежуточные величины — 4 знака, без округления.
2. Округление ROUND_HALF_UP до 2 знаков — ровно в трёх точках: сумма строки
   документа, сумма НДС строки, итоги документа.
3. Итог документа считается суммой **уже округлённых** строк, чтобы «итого»
   сходилось с колонкой на экране и в печатной форме.
4. Сложение разных валют — исключение, а не автоматическая конвертация.

`float` запрещён на всех уровнях (`CLAUDE.md § 3` п. 1).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Final

CALC_PLACES: Final = 4
DISPLAY_PLACES: Final = 2

CALC_QUANT: Final = Decimal("0.0001")
DISPLAY_QUANT: Final = Decimal("0.01")

SUPPORTED_CURRENCIES: Final = frozenset({"RUB", "USD", "EUR"})
BASE_CURRENCY: Final = "RUB"


class MoneyError(Exception):
    """Базовая ошибка денежной арифметики."""


class CurrencyMismatch(MoneyError):
    """Попытка сложить или сравнить суммы в разных валютах.

    Отображается в HTTP 400 с кодом `CURRENCY_MISMATCH` (`BACKEND.md § 9`).
    """


class UnsupportedCurrency(MoneyError):
    """Валюта вне перечня поддерживаемых `[ТЗ 3.4.1]`."""


def to_decimal(value: Decimal | int | str) -> Decimal:
    """Приводит значение к Decimal.

    `float` не принимается намеренно: двоичное представление 0.1 не равно 0.1,
    и в деньгах это превращается в расхождение на копейки.
    """
    if isinstance(value, float):
        raise MoneyError(
            "float недопустим в денежных расчётах (CLAUDE.md § 3 п. 1). "
            "Передайте Decimal или строку."
        )
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise MoneyError(f"не удалось разобрать десятичное число: {value!r}") from exc


@dataclass(frozen=True, slots=True)
class Money:
    """Сумма в конкретной валюте.

    Неизменяема: любая операция возвращает новый объект. Это защищает снимки
    цен (`CLAUDE.md § 3` п. 5) от случайной правки на месте.
    """

    amount: Decimal
    currency: str

    def __post_init__(self) -> None:
        if self.currency not in SUPPORTED_CURRENCIES:
            raise UnsupportedCurrency(
                f"валюта {self.currency!r} не поддерживается; "
                f"допустимы {sorted(SUPPORTED_CURRENCIES)}"
            )
        if not isinstance(self.amount, Decimal):
            raise MoneyError("amount обязан быть Decimal")

    # ─────────────────────────── Конструкторы ───────────────────────────

    @classmethod
    def of(cls, amount: Decimal | int | str, currency: str) -> Money:
        """Создаёт сумму, приводя значение к 4 знакам без округления результата."""
        return cls(to_decimal(amount).quantize(CALC_QUANT, rounding=ROUND_HALF_UP), currency)

    @classmethod
    def zero(cls, currency: str) -> Money:
        return cls(Decimal("0").quantize(CALC_QUANT), currency)

    # ─────────────────────────── Арифметика ───────────────────────────

    def _check_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise CurrencyMismatch(
                f"нельзя работать с {self.currency} и {other.currency} без явной "
                f"конвертации: используйте convert()"
            )

    def __add__(self, other: Money) -> Money:
        self._check_same_currency(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._check_same_currency(other)
        return Money(self.amount - other.amount, self.currency)

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def multiply(self, factor: Decimal | int | str) -> Money:
        """Умножение на количество или коэффициент. Округления нет — только 4 знака."""
        result = self.amount * to_decimal(factor)
        return Money(result.quantize(CALC_QUANT, rounding=ROUND_HALF_UP), self.currency)

    def percent(self, percent_value: Decimal | int | str) -> Money:
        """Процент от суммы. Используется для наценок, скидок, НДС и надбавок."""
        return self.multiply(to_decimal(percent_value) / Decimal("100"))

    def __lt__(self, other: Money) -> bool:
        self._check_same_currency(other)
        return self.amount < other.amount

    def __le__(self, other: Money) -> bool:
        self._check_same_currency(other)
        return self.amount <= other.amount

    def __gt__(self, other: Money) -> bool:
        self._check_same_currency(other)
        return self.amount > other.amount

    def __ge__(self, other: Money) -> bool:
        self._check_same_currency(other)
        return self.amount >= other.amount

    # ─────────────────────────── Округление ───────────────────────────

    def rounded(self) -> Money:
        """Округление до 2 знаков ROUND_HALF_UP.

        Вызывается только в трёх местах (ADR-002): сумма строки документа,
        сумма НДС строки, итоги документа. В расчётах заявок не применяется.
        """
        return Money(
            self.amount.quantize(DISPLAY_QUANT, rounding=ROUND_HALF_UP).quantize(CALC_QUANT),
            self.currency,
        )

    @property
    def is_zero(self) -> bool:
        return self.amount == 0

    @property
    def is_negative(self) -> bool:
        """Отрицательная сумма — штатное состояние (отрицательная маржа)."""
        return self.amount < 0

    # ─────────────────────────── Представление ───────────────────────────

    def to_display(self) -> str:
        """Строка для интерфейса и печатных форм: ровно 2 знака."""
        return str(self.amount.quantize(DISPLAY_QUANT, rounding=ROUND_HALF_UP))

    def to_json(self) -> dict[str, str]:
        """Представление для API: сумма строкой, 4 знака (`openapi.yaml` Money)."""
        return {"amount": str(self.amount), "currency": self.currency}

    def __str__(self) -> str:
        return f"{self.to_display()} {self.currency}"

    def __repr__(self) -> str:
        return f"Money({self.amount!r}, {self.currency!r})"


def money_sum(items: list[Money], currency: str) -> Money:
    """Сумма списка. Пустой список даёт ноль в указанной валюте, а не ошибку."""
    total = Money.zero(currency)
    for item in items:
        total = total + item
    return total


def convert(value: Money, to_currency: str, rates: Mapping[str, Decimal | str]) -> Money:
    """Явная конвертация валюты через базу (ADR-004).

    `rates[c]` — сколько рублей стоит одна единица валюты `c`; `rates['RUB'] == 1`.
    Номинал источника (100 JPY, 10 CNY) нормализуется при загрузке курсов,
    а не здесь.

    Промежуточное значение в базовой валюте не округляется: округление выполняется
    один раз, на результате, до 4 знаков.
    """
    if to_currency not in SUPPORTED_CURRENCIES:
        raise UnsupportedCurrency(f"валюта {to_currency!r} не поддерживается")
    if value.currency == to_currency:
        return value

    try:
        rate_from = to_decimal(rates[value.currency])
        rate_to = to_decimal(rates[to_currency])
    except KeyError as exc:
        raise MoneyError(f"в снимке курсов отсутствует валюта {exc.args[0]!r}") from exc

    if rate_to == 0:
        raise MoneyError(f"нулевой курс для {to_currency}: конвертация невозможна")

    in_base = value.amount * rate_from
    result = in_base / rate_to
    return Money(result.quantize(CALC_QUANT, rounding=ROUND_HALF_UP), to_currency)
