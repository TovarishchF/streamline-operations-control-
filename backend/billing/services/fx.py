"""Курсы валют: загрузка и выдача снимка `[ТЗ 3.4.1]`.

Загрузка идёт через фабрику адаптера (`CLAUDE.md § 3` п. 4): доменный код
не знает, отвечает ли ЦБ РФ или заглушка. Фактический режим виден
в журнале обменов и на экране подключений.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import transaction

from billing.models import FxRate
from core import clock
from core.models import DataSource
from integrations.base import Exchange, get_provider, mode_for, record_exchange
from integrations.models import IntegrationMode

# Сколько дней назад искать последний известный курс, если на нужную дату
# его нет. Дольше двух недель курс неактуален, и молча подставлять его хуже,
# чем сказать, что данных нет.
MAX_STALE_DAYS = 14


@transaction.atomic
def sync_rates(on_date: date | None = None) -> int:
    """Загружает курсы на дату и сохраняет их. Возвращает число записей.

    Повторный запуск за ту же дату обновляет записи, а не плодит их:
    задача выполняется по расписанию и переживает повторный запуск
    (`BACKEND.md § 5`).
    """
    target = on_date or clock.now().date()
    provider = get_provider("FX")

    def call() -> tuple[Any, Exchange]:
        result: tuple[Any, Exchange] = provider.rates_on_date(target)
        return result

    rate_set = record_exchange("FX", call)

    live = mode_for("FX") == IntegrationMode.LIVE
    source = DataSource.LIVE if live else DataSource.SYNTHETIC

    written = 0
    for currency, value in rate_set.rates.items():
        FxRate.objects.update_or_create(
            on_date=rate_set.on_date,
            currency=currency,
            defaults={"rate": value, "data_source": source, "is_demo": not live},
        )
        written += 1
    return written


def history(since: date, until: date) -> list[dict[str, Any]]:
    """Курсы за период: по дате — набор валют.

    Нужны графику динамики. Пустой список означает, что за период курсов
    не загружено, а не что они равны нулю.
    """
    by_date: dict[date, dict[str, str]] = {}
    for item in FxRate.objects.filter(on_date__gte=since, on_date__lte=until).order_by("on_date"):
        by_date.setdefault(item.on_date, {})[item.currency] = _as_contract_decimal(item.rate)
    return [
        {"date": day.isoformat(), "rates": rates} for day, rates in sorted(by_date.items())
    ]


def snapshot(on_date: date | None = None) -> dict[str, Any]:
    """Снимок курсов на дату в форме контракта (`FxSnapshot`).

    Если курса на запрошенную дату нет, берётся последний известный
    и заполняется `staleSince`: пользователь должен видеть, что расчёт
    сделан по устаревшему курсу, а не гадать.
    """
    target = on_date or clock.now().date()
    base = str(settings.FX_BASE_CURRENCY)

    exact = list(FxRate.objects.filter(on_date=target))
    stale_since: date | None = None

    if not exact:
        fallback = (
            FxRate.objects.filter(
                on_date__lt=target, on_date__gte=target - timedelta(days=MAX_STALE_DAYS)
            )
            .order_by("-on_date")
            .first()
        )
        if fallback is not None:
            stale_since = fallback.on_date
            exact = list(FxRate.objects.filter(on_date=fallback.on_date))

    rates = {item.currency: _as_contract_decimal(item.rate) for item in exact}
    rates.setdefault(base, "1.0000")

    settings_object = _settings()
    return {
        "date": target.isoformat(),
        "base": base,
        "rates": rates,
        "policy": settings_object.fx_policy,
        "source": exact[0].data_source if exact else DataSource.SYNTHETIC,
        "staleSince": stale_since.isoformat() if stale_since else None,
    }


def rate_for(currency: str, on_date: date) -> Decimal:
    """Курс валюты к рублю на дату. Для рубля — единица."""
    base = str(settings.FX_BASE_CURRENCY)
    if currency == base:
        return Decimal(1)

    record = (
        FxRate.objects.filter(currency=currency, on_date__lte=on_date)
        .order_by("-on_date")
        .first()
    )
    if record is None:
        raise LookupError(f"курс {currency} на {on_date:%d.%m.%Y} не загружен")
    return record.rate


def _as_contract_decimal(value: Decimal) -> str:
    """Десятичной строкой: число с плавающей точкой в JSON запрещено."""
    return f"{value:.4f}"


def _settings() -> Any:
    from core.models import Settings

    return Settings.get_solo()
