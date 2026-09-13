"""Курсы валют ЦБ РФ `[ТЗ 3.4.1]` (`INTEGRATIONS.md § 2.1`).

Источник: `https://www.cbr.ru/scripts/XML_daily.asp?date_req=DD/MM/YYYY`.
Открытый, ключ не нужен, регистрация не нужна.

Два подводных камня, из-за которых наивная реализация даёт неверные суммы:

* **номинал.** ЦБ публикует курс за номинал: иена — за 100 единиц, тенге —
  за 100. Курс делится на номинал, иначе счёт в иенах уедет в сто раз.
* **десятичный разделитель.** В ответе запятая: `92,4512`. `Decimal("92,4512")`
  возбуждает исключение, а `float(...)` его не возбуждает и портит деньги —
  ровно поэтому `float` в расчётах запрещён (`CLAUDE.md § 3` п. 1).

Курс на выходной день ЦБ не публикует: отдаётся курс последнего рабочего дня,
и это верное поведение — именно он и действует в выходные.
"""

from __future__ import annotations

import urllib.request
from datetime import date, timedelta
from decimal import Decimal
from xml.etree import ElementTree

from django.conf import settings

from integrations.base import Exchange
from integrations.fx.base import RateSet

ENDPOINT = "https://www.cbr.ru/scripts/XML_daily.asp"
TIMEOUT_SECONDS = 20

# Сколько дней отступать назад в поисках последнего рабочего дня.
# Длинные новогодние каникулы в России доходят до десяти дней.
MAX_LOOKBACK_DAYS = 12


class Provider:
    """Боевой адаптер курсов ЦБ РФ."""

    code = "FX"

    def rates_on_date(self, on_date: date) -> tuple[RateSet, Exchange]:
        for offset in range(MAX_LOOKBACK_DAYS):
            requested = on_date - timedelta(days=offset)
            url = f"{ENDPOINT}?date_req={requested:%d/%m/%Y}"
            payload = self._fetch(url)
            rates = self._parse(payload)
            if rates:
                # ЦБ отдаёт запрошенную дату в атрибуте Date: в выходной
                # это дата последнего рабочего дня.
                published = self._published_date(payload) or requested
                return (
                    RateSet(on_date=published, rates=rates),
                    Exchange(
                        operation="rates_on_date",
                        endpoint=url,
                        response_body=payload[:20_000],
                        response_bytes=len(payload.encode("utf-8")),
                        http_status=200,
                    ),
                )
        raise RuntimeError(
            f"ЦБ РФ не вернул курсы за {MAX_LOOKBACK_DAYS} дней до {on_date:%d.%m.%Y}"
        )

    def _fetch(self, url: str) -> str:
        # Адрес задан константой и собирается из даты: сторонней схемы
        # вроде file: сюда попасть неоткуда.
        request = urllib.request.Request(url, headers={"User-Agent": "SOC/1.0"})  # noqa: S310
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            raw: bytes = response.read()
        # Ответ в windows-1251, кодировка объявлена в заголовке XML.
        return raw.decode("windows-1251", errors="replace")

    def _parse(self, payload: str) -> dict[str, Decimal]:
        root = ElementTree.fromstring(payload)  # noqa: S314
        supported = set(settings.SUPPORTED_CURRENCIES)
        base = str(settings.FX_BASE_CURRENCY)

        rates: dict[str, Decimal] = {base: Decimal(1)}
        for item in root.findall("Valute"):
            code = (item.findtext("CharCode") or "").strip()
            if code not in supported or code == base:
                continue
            value = (item.findtext("Value") or "").strip().replace(",", ".")
            nominal = (item.findtext("Nominal") or "1").strip().replace(",", ".")
            if not value:
                continue
            rates[code] = Decimal(value) / Decimal(nominal)

        # Одна только база — это не курсы: значит разобрать не удалось.
        return rates if len(rates) > 1 else {}

    def _published_date(self, payload: str) -> date | None:
        root = ElementTree.fromstring(payload)  # noqa: S314
        raw = root.attrib.get("Date", "")
        if not raw:
            return None
        day, month, year = raw.split(".")
        return date(int(year), int(month), int(day))
