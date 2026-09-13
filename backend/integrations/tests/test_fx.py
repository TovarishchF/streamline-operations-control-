"""Курсы валют `[ТЗ 3.4.1]` (`INTEGRATIONS.md § 2.1`).

Сеть в испытаниях не используется (`TESTING.md § 4`): боевой адаптер
проверяется против записанного ответа ЦБ РФ. Именно так ловятся две ошибки,
из-за которых наивная реализация даёт неверные суммы, — номинал и запятая
как десятичный разделитель.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from django.test import override_settings

from billing.models import FxRate
from billing.services import fx
from core.models import DataSource
from integrations.fx.live import Provider as LiveProvider
from integrations.fx.stub import Provider as StubProvider
from integrations.models import ExchangeStatus, IntegrationLog

RECORDED = Path(__file__).parent / "fixtures" / "cbr-2026-09-11.xml"


def _recorded_payload() -> str:
    return RECORDED.read_bytes().decode("windows-1251")


class TestLiveParser:
    """Разбор настоящего ответа ЦБ РФ."""

    def test_comma_is_a_decimal_separator(self) -> None:
        """`Decimal("92,45")` возбуждает исключение, `float` — портит деньги."""
        rates = LiveProvider()._parse(_recorded_payload())

        assert rates["USD"] > Decimal(50)
        assert isinstance(rates["USD"], Decimal)

    def test_nominal_is_normalised_to_one_unit(self) -> None:
        """ЦБ публикует иену за сто единиц. Без деления счёт уедет в сто раз."""
        payload = _recorded_payload()

        with override_settings(SUPPORTED_CURRENCIES=["RUB", "JPY"]):
            rates = LiveProvider()._parse(payload)

        # В записанном ответе: Nominal 100, Value 54,8944 → курс за единицу.
        assert rates["JPY"] == Decimal("54.8944") / Decimal(100)
        assert rates["JPY"] < Decimal(1)

    def test_base_currency_is_one(self) -> None:
        rates = LiveProvider()._parse(_recorded_payload())

        assert rates["RUB"] == Decimal(1)

    def test_published_date_is_taken_from_the_answer(self) -> None:
        """В выходной ЦБ отдаёт дату последнего рабочего дня."""
        published = LiveProvider()._published_date(_recorded_payload())

        assert published == date(2026, 9, 11)

    def test_unparsable_answer_yields_nothing(self) -> None:
        """Пустой разбор должен быть отличим от «курс равен единице»."""
        empty = '<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="11.09.2026"/>'

        assert LiveProvider()._parse(empty) == {}


class TestStub:
    def test_same_day_gives_the_same_rate(self) -> None:
        """Стенд не должен дрожать между обновлениями страницы."""
        first, _ = StubProvider().rates_on_date(date(2026, 3, 10))
        second, _ = StubProvider().rates_on_date(date(2026, 3, 10))

        assert first.rates == second.rates

    def test_neighbouring_days_differ(self) -> None:
        monday, _ = StubProvider().rates_on_date(date(2026, 3, 9))
        tuesday, _ = StubProvider().rates_on_date(date(2026, 3, 10))

        assert monday.rates["USD"] != tuesday.rates["USD"]

    def test_weekend_repeats_friday(self) -> None:
        """Так же ведёт себя и настоящий источник."""
        friday, _ = StubProvider().rates_on_date(date(2026, 3, 13))
        sunday, _ = StubProvider().rates_on_date(date(2026, 3, 15))

        assert sunday.on_date == friday.on_date
        assert sunday.rates == friday.rates

    def test_rates_stay_plausible(self) -> None:
        rate_set, _ = StubProvider().rates_on_date(date(2026, 3, 10))

        assert Decimal(60) < rate_set.rates["USD"] < Decimal(140)
        assert rate_set.rates["RUB"] == Decimal(1)


@pytest.mark.django_db
class TestSync:
    def test_stub_data_is_not_passed_off_as_live(self) -> None:
        """`CLAUDE.md § 4`: заглушка не изображает живое подключение."""
        fx.sync_rates(date(2026, 3, 10))

        assert set(FxRate.objects.values_list("data_source", flat=True)) == {
            DataSource.SYNTHETIC
        }

    def test_every_call_is_logged_with_the_actual_mode(self) -> None:
        fx.sync_rates(date(2026, 3, 10))

        entry = IntegrationLog.objects.get(code="FX")
        assert entry.mode == "stub"
        assert entry.status == ExchangeStatus.OK
        assert entry.operation == "rates_on_date"

    def test_repeated_sync_does_not_duplicate(self) -> None:
        """Задача по расписанию может сработать дважды (`BACKEND.md § 5`)."""
        fx.sync_rates(date(2026, 3, 10))
        before = FxRate.objects.count()

        fx.sync_rates(date(2026, 3, 10))

        assert FxRate.objects.count() == before


@pytest.mark.django_db
class TestSnapshot:
    def test_reports_that_the_rate_is_stale(self) -> None:
        """Расчёт по устаревшему курсу допустим, молчание о нём — нет."""
        fx.sync_rates(date(2026, 3, 10))

        snapshot = fx.snapshot(date(2026, 3, 12))

        assert snapshot["staleSince"] == "2026-03-10"
        assert snapshot["rates"]["USD"]

    def test_exact_date_is_not_marked_stale(self) -> None:
        fx.sync_rates(date(2026, 3, 10))

        assert fx.snapshot(date(2026, 3, 10))["staleSince"] is None

    def test_rates_are_decimal_strings(self) -> None:
        """Число с плавающей точкой в JSON запрещено (`CLAUDE.md § 3` п. 1)."""
        fx.sync_rates(date(2026, 3, 10))

        rates = fx.snapshot(date(2026, 3, 10))["rates"]

        assert all(isinstance(value, str) for value in rates.values())
        assert rates["RUB"] == "1.0000"

    def test_too_old_rate_is_not_substituted_silently(self) -> None:
        fx.sync_rates(date(2026, 3, 10))

        snapshot = fx.snapshot(date(2026, 3, 10) + timedelta(days=fx.MAX_STALE_DAYS + 1))

        assert snapshot["rates"] == {"RUB": "1.0000"}

    def test_base_currency_needs_no_lookup(self) -> None:
        assert fx.rate_for("RUB", date(2026, 3, 10)) == Decimal(1)

    def test_missing_rate_is_an_error_not_a_guess(self) -> None:
        with pytest.raises(LookupError):
            fx.rate_for("USD", date(2026, 3, 10))
