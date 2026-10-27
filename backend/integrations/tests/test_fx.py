"""Курсы валют `[ТЗ 3.4.1]` (`INTEGRATIONS.md § 2.1`).

Сеть в испытаниях не используется (`TESTING.md § 4`): боевой адаптер
проверяется против записанного ответа ЦБ РФ. Именно так ловятся две ошибки,
из-за которых наивная реализация даёт неверные суммы, — номинал и запятая
как десятичный разделитель.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from django.test import override_settings
from freezegun import freeze_time

from billing.models import FxRate
from billing.services import fx
from core.models import DataSource
from integrations.base import IntegrationNotConfigured
from integrations.fx.live import Provider as LiveProvider
from integrations.models import ExchangeStatus, IntegrationLog

RECORDED = Path(__file__).parent / "fixtures" / "cbr-2026-09-11.xml"


# Дата публикации в записанном ответе ЦБ.
PUBLISHED = date(2026, 9, 11)


def _recorded_payload() -> str:
    return RECORDED.read_bytes().decode("windows-1251")


@pytest.fixture
def cbr(settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Подключение FX включено, а ЦБ отвечает записанным ответом."""
    settings.INTEGRATIONS_ENABLED = ["FX"]
    monkeypatch.setattr(LiveProvider, "_fetch", lambda self, url: _recorded_payload())


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


@pytest.mark.django_db
@pytest.mark.usefixtures("cbr")
class TestSync:
    def test_rates_are_stored_as_live_data(self) -> None:
        fx.sync_rates(PUBLISHED)

        assert set(FxRate.objects.values_list("data_source", flat=True)) == {DataSource.LIVE}
        assert FxRate.objects.get(currency="USD", on_date=PUBLISHED).rate > Decimal(50)

    def test_every_call_is_logged(self) -> None:
        fx.sync_rates(PUBLISHED)

        entry = IntegrationLog.objects.get(code="FX")
        assert entry.mode == "live"
        assert entry.status == ExchangeStatus.OK
        assert entry.operation == "rates_on_date"

    def test_repeated_sync_does_not_duplicate(self) -> None:
        """Задача по расписанию может сработать дважды (`BACKEND.md § 5`)."""
        fx.sync_rates(PUBLISHED)
        before = FxRate.objects.count()

        fx.sync_rates(PUBLISHED)

        assert FxRate.objects.count() == before


@pytest.mark.django_db
def test_disabled_connection_gives_no_rates_at_all(settings: Any) -> None:
    """ADR-039: выключенное подключение не подменяется выдуманными курсами."""
    settings.INTEGRATIONS_ENABLED = []

    with pytest.raises(IntegrationNotConfigured):
        fx.sync_rates(PUBLISHED)

    assert not FxRate.objects.exists()


@pytest.mark.django_db
@pytest.mark.usefixtures("cbr")
class TestSnapshot:
    def test_reports_that_the_rate_is_stale(self) -> None:
        """Расчёт по устаревшему курсу допустим, молчание о нём — нет."""
        fx.sync_rates(PUBLISHED)

        snapshot = fx.snapshot(PUBLISHED + timedelta(days=2))

        assert snapshot["staleSince"] == PUBLISHED.isoformat()
        assert snapshot["rates"]["USD"]

    def test_exact_date_is_not_marked_stale(self) -> None:
        fx.sync_rates(PUBLISHED)

        assert fx.snapshot(PUBLISHED)["staleSince"] is None

    def test_rates_are_decimal_strings(self) -> None:
        """Число с плавающей точкой в JSON запрещено (`CLAUDE.md § 3` п. 1)."""
        fx.sync_rates(PUBLISHED)

        rates = fx.snapshot(PUBLISHED)["rates"]

        assert all(isinstance(value, str) for value in rates.values())
        assert rates["RUB"] == "1.0000"

    def test_too_old_rate_is_not_substituted_silently(self) -> None:
        fx.sync_rates(PUBLISHED)

        snapshot = fx.snapshot(PUBLISHED + timedelta(days=fx.MAX_STALE_DAYS + 1))

        assert snapshot["rates"] == {"RUB": "1.0000"}

    def test_future_date_takes_the_latest_known_rate(self) -> None:
        """Курса на дату через три недели ещё нет — берётся последний известный
        с отметкой давности, а не пустой снимок, на котором падает пересчёт."""
        fx.sync_rates(PUBLISHED)

        with freeze_time(datetime.combine(PUBLISHED + timedelta(days=1), time(9), tzinfo=UTC)):
            snapshot = fx.snapshot(PUBLISHED + timedelta(days=fx.MAX_STALE_DAYS + 7))

        assert snapshot["rates"]["USD"]
        assert snapshot["staleSince"] == PUBLISHED.isoformat()

    def test_flight_snapshot_without_rates_is_taken_again(self) -> None:
        """В снимке всегда есть рубль: рейс, заведённый, когда курсов не было,
        выглядел бы обеспеченным курсами и не получал их никогда."""
        fx.sync_rates(PUBLISHED)
        flight = SimpleNamespace(
            fx_snapshot={"base": "RUB", "rates": {"RUB": "1.0000"}},
            std_utc=datetime.combine(PUBLISHED, time(12), tzinfo=UTC),
        )

        assert fx.rates_for(flight)["USD"]
        assert fx.snapshot_for(flight)["date"] == PUBLISHED.isoformat()

    def test_flight_snapshot_with_rates_is_kept(self) -> None:
        """Снимок, а не ссылка: загруженные позже курсы его не переписывают."""
        fx.sync_rates(PUBLISHED)
        stored = {"base": "RUB", "rates": {"RUB": "1.0000", "USD": "90.0000"}}
        flight = SimpleNamespace(
            fx_snapshot=stored, std_utc=datetime.combine(PUBLISHED, time(12), tzinfo=UTC)
        )

        assert fx.snapshot_for(flight) == stored

    def test_base_currency_needs_no_lookup(self) -> None:
        assert fx.rate_for("RUB", date(2026, 3, 10)) == Decimal(1)

    def test_missing_rate_is_an_error_not_a_guess(self) -> None:
        with pytest.raises(LookupError):
            fx.rate_for("USD", date(2026, 3, 10))
