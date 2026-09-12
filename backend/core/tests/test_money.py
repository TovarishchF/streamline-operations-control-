"""Тесты денежной арифметики.

Обязательный перечень — `TESTING.md § 2`, раздел «Деньги». Список не подлежит
сокращению: это места, где ошибка стоит денег заказчика.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.money import (
    CurrencyMismatch,
    Money,
    MoneyError,
    UnsupportedCurrency,
    convert,
    money_sum,
)

# ─────────────────────────── Запрет float ───────────────────────────


def test_float_rejected_on_construction() -> None:
    """float в деньгах запрещён на всех уровнях (CLAUDE.md § 3 п. 1)."""
    with pytest.raises(MoneyError, match="float недопустим"):
        Money.of(1234.56, "USD")  # type: ignore[arg-type]


def test_float_rejected_in_multiply() -> None:
    money = Money.of("100", "USD")
    with pytest.raises(MoneyError, match="float недопустим"):
        money.multiply(1.5)  # type: ignore[arg-type]


def test_unsupported_currency_rejected() -> None:
    with pytest.raises(UnsupportedCurrency):
        Money.of("100", "GBP")


# ─────────────────────── Сложение разных валют ───────────────────────


def test_addition_of_different_currencies_raises() -> None:
    """Неявной конвертации не существует (DOMAIN § 1)."""
    with pytest.raises(CurrencyMismatch):
        Money.of("100", "USD") + Money.of("100", "EUR")


def test_subtraction_of_different_currencies_raises() -> None:
    with pytest.raises(CurrencyMismatch):
        Money.of("100", "USD") - Money.of("100", "RUB")


def test_comparison_of_different_currencies_raises() -> None:
    with pytest.raises(CurrencyMismatch):
        _ = Money.of("100", "USD") < Money.of("100", "EUR")


# ─────────────────── Округление на граничных значениях ───────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0.005", "0.01"),   # ROUND_HALF_UP, не банковское округление
        ("0.015", "0.02"),
        ("2.675", "2.68"),   # классический случай, где float даёт 2.67
        ("0.004", "0.00"),
        ("-0.005", "-0.01"),
        ("1.0050", "1.01"),
    ],
)
def test_half_up_rounding_on_boundaries(raw: str, expected: str) -> None:
    """ROUND_HALF_UP на граничных значениях (TESTING § 2)."""
    assert Money.of(raw, "USD").to_display() == expected


def test_float_would_have_been_wrong_for_2_675() -> None:
    """Показывает, зачем запрещён float: round(2.675, 2) в Python даёт 2.67."""
    assert round(2.675, 2) == 2.67
    assert Money.of("2.675", "USD").to_display() == "2.68"


# ─────────────────── Накопление погрешности на объёме ───────────────────


def test_sum_of_1000_items_does_not_drift() -> None:
    """Сумма 1000 позиций по 0.005 не расходится с ожидаемой (TESTING § 2)."""
    items = [Money.of("0.005", "USD") for _ in range(1000)]
    total = money_sum(items, "USD")
    assert total.amount == Decimal("5.0000")
    assert total.to_display() == "5.00"


def test_sum_of_empty_list_is_zero_not_error() -> None:
    """Рейс без услуг — штатная ситуация, а не ошибка."""
    assert money_sum([], "RUB").is_zero


def test_intermediate_values_keep_four_places() -> None:
    """ADR-002 п. 1: промежуточные величины не округляются до 2 знаков."""
    cost = Money.of("100", "USD").percent("33.3333")
    assert cost.amount == Decimal("33.3333")


# ─────────────────────────── Конвертация ───────────────────────────

# ADR-004: база — рубль, rates[c] — сколько рублей стоит одна единица валюты c.
RATES = {"RUB": Decimal("1"), "USD": Decimal("92.4500"), "EUR": Decimal("100.1200")}


def test_convert_to_same_currency_is_identity() -> None:
    money = Money.of("100.1234", "USD")
    assert convert(money, "USD", RATES) == money


def test_convert_usd_to_rub_uses_base_rate() -> None:
    result = convert(Money.of("100", "USD"), "RUB", RATES)
    assert result.amount == Decimal("9245.0000")
    assert result.currency == "RUB"


def test_convert_cross_currency_goes_through_base() -> None:
    """USD → EUR считается через рубль, промежуточное значение не округляется."""
    result = convert(Money.of("100", "USD"), "EUR", RATES)
    expected = (Decimal("100") * Decimal("92.4500") / Decimal("100.1200")).quantize(
        Decimal("0.0001")
    )
    assert result.amount == expected


def test_convert_round_trip_loses_no_more_than_tolerance() -> None:
    """Конвертация туда-обратно не теряет копейки сверх допустимого (TESTING § 2)."""
    original = Money.of("1000.0000", "USD")
    there = convert(original, "RUB", RATES)
    back = convert(there, "USD", RATES)
    assert abs(back.amount - original.amount) <= Decimal("0.0001")


def test_convert_with_missing_rate_reports_which_currency() -> None:
    with pytest.raises(MoneyError, match="EUR"):
        convert(Money.of("100", "EUR"), "RUB", {"RUB": Decimal("1")})


def test_convert_with_zero_rate_does_not_divide_by_zero() -> None:
    with pytest.raises(MoneyError, match="нулевой курс"):
        convert(Money.of("100", "RUB"), "USD", {"RUB": Decimal("1"), "USD": Decimal("0")})


# ─────────────────────── Отрицательные суммы ───────────────────────


def test_negative_margin_is_not_zeroed() -> None:
    """Отрицательная маржа — не ошибка, она должна отображаться (DOMAIN § 7.3)."""
    revenue = Money.of("1000", "USD")
    cost = Money.of("1500", "USD")
    margin = revenue - cost
    assert margin.is_negative
    assert margin.to_display() == "-500.00"


# ─────────────────────── Неизменяемость ───────────────────────


def test_money_is_immutable() -> None:
    """Снимок цены нельзя испортить правкой на месте (CLAUDE.md § 3 п. 5)."""
    snapshot = Money.of("100", "USD")
    with pytest.raises(AttributeError):
        snapshot.amount = Decimal("200")  # type: ignore[misc]


def test_arithmetic_returns_new_object() -> None:
    original = Money.of("100", "USD")
    result = original + Money.of("50", "USD")
    assert original.amount == Decimal("100.0000")
    assert result.amount == Decimal("150.0000")


# ─────────────────────── Представление в API ───────────────────────


def test_json_representation_is_string_not_number() -> None:
    """В JSON деньги передаются строкой (openapi.yaml Money)."""
    payload = Money.of("1234.5600", "USD").to_json()
    assert payload == {"amount": "1234.5600", "currency": "USD"}
    assert isinstance(payload["amount"], str)
