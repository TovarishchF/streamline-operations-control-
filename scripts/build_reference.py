"""Сборка справочника аэропортов из открытых источников.

Инструмент разработчика, а не часть работающей системы. Запускается вручную,
результат — `shared/reference/airports.csv`, который попадает в репозиторий
и загружается командой `make seed-reference`. По `INTEGRATIONS.md § 2.4`
справочник загружается один раз и хранится в базе, заглушка ему не нужна,
поэтому адаптера здесь нет: это разовая подготовка данных.

Источники, все открытые и не требующие учётных данных:

* **OurAirports** — ICAO, IATA, координаты, превышение, страна, тип аэропорта.
  Общественное достояние.
* **OpenFlights** — зона IANA для аэропорта. ODbL, требует указания источника.

Поверх них ложится выверенный вручную `airport-overrides.csv`: русские
наименования и часовые зоны для СНГ. Машинная транслитерация выдавала бы
придуманное название за принятое, а зоны в OpenFlights местами устарели.
Необязательным дополнением по ключу `--wikidata` заполняются наименования
остальных аэропортов — служба часто недоступна, поэтому сборка от неё не зависит.

Зона, которой нет ни в наложении, ни в OpenFlights, берётся у ближайшего
аэропорта той же страны: границы часовых зон идут по административным границам.
Результат проверяется тестом `catalog/tests/test_reference.py`: зона должна
существовать в tzdb, а её смещение — согласовываться с долготой.

Запуск:
    python scripts/build_reference.py              # из кэша, докачивает недостающее
    python scripts/build_reference.py --refresh    # перекачать исходные наборы
    python scripts/build_reference.py --offline    # только кэш, без сети
    python scripts/build_reference.py --wikidata   # дополнить наименования
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "reference"
OUT = ROOT / "shared" / "reference" / "airports.csv"
OVERRIDES = ROOT / "shared" / "reference" / "airport-overrides.csv"

OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OPENFLIGHTS_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat"
WIKIDATA_URL = "https://query.wikidata.org/sparql"
USER_AGENT = "SOC-reference-builder/1.0 (dispatch platform reference data)"

NULL = "\\" + "N"  # OpenFlights обозначает пустое значение так

# Страны СНГ и сопредельные: для них берутся и средние аэропорты —
# деловая авиация работает не только через крупные узлы.
CIS = frozenset({"RU", "KZ", "BY", "UZ", "KG", "TJ", "TM", "AM", "AZ", "GE", "MD", "UA"})

# Аэропорты деловой авиации, которые в классификации OurAirports не «крупные»,
# но без них справочник для этой отрасли неполон.
BUSINESS_AVIATION = frozenset(
    {
        "KTEB", "KVNY", "KHPN", "KBED", "KPBI", "KOPF",
        "LFPB", "LFMD", "EGGW", "EGKB", "EGLF", "EGKA", "EGTK",
        "LSGG", "LSZH", "LSGS", "LSZS", "LOWS", "LOWI",
        "LIRA", "LIML", "LIPZ", "LFSB", "LFKB", "EDDB",
        "EDMO", "EDDK", "EDNY", "LEPA", "LEIB", "LEMG", "LEBB",
        "LGKO", "LGMK", "LGSR", "LMML", "LCPH", "LTBJ", "LTFE",
        "UUMO", "UUBW", "UUWW", "ULLI", "UUDL", "UWGG", "URKA",
        "OMDW", "OTHH", "OERK", "OMAA", "LLBG",
        "VTBD", "WSSL", "VHHH", "RJTT",
    }
)

# Координируемые аэропорты (IATA Level 3). Перечень — снимок открытых
# публикаций координаторов на 2026 год. Заказчик свой перечень ещё не передал
# (G-34, ADR-026), поэтому признак редактируется администратором,
# а проверка слота при подготовке рейса — мягкая.
COORDINATED = frozenset(
    {
        "EGLL", "EGKK", "EGSS", "EGGW", "EGPH", "EGCC",
        "LFPG", "LFPO", "LFMN", "LFLL", "LFML",
        "EDDF", "EDDM", "EDDL", "EDDB", "EDDH", "EDDK", "EDDS",
        "EHAM", "EBBR", "ELLX", "EKCH", "ESSA", "ENGM", "EFHK",
        "LEMD", "LEBL", "LEPA", "LEAL", "LEMG", "LEIB",
        "LIRF", "LIMC", "LIML", "LIPZ", "LIRN", "LICC", "LICJ",
        "LOWW", "LSZH", "LSGG", "LPPT", "LPPR", "LPFR",
        "LGAV", "LGTS", "LGIR", "LGRP", "LGKO", "LGSR", "LGZA",
        "LTFM", "LTAI", "LTBJ", "LTFJ", "LMML", "LCLK", "LDZA",
        "UUEE", "UUDD", "UUWW", "ULLI",
        "OMDB", "OMAA", "OTHH", "OERK", "OEJN", "LLBG",
        "VHHH", "RJTT", "RJAA", "RJBB", "RKSI", "ZBAA", "ZSPD", "ZGGG",
        "VIDP", "VABB", "VTBS", "WSSS", "WMKK", "WIII",
        "YSSY", "YMML", "YBBN", "NZAA",
        "SBGR", "SBGL", "SAEZ", "SCEL", "MMMX",
        "FACT", "FAOR", "HECA", "DAAG", "GMMN", "DTTA",
    }
)


# Страны, у которых в OpenFlights нет ни одного аэропорта с текущим префиксом
# ICAO: ИКАО переназначила им префиксы (Киргизия UA→UC, Узбекистан UT→UZ),
# а набор ведётся по старым кодам. Обе страны живут в одной часовой зоне,
# поэтому соответствие однозначно.
SINGLE_ZONE_COUNTRY = {
    "KG": "Asia/Bishkek",
    "UZ": "Asia/Tashkent",
}


def load_overrides() -> dict[str, dict[str, str]]:
    """Выверенные вручную наименования и часовые зоны: ICAO → поля."""
    if not OVERRIDES.exists():
        return {}
    overrides: dict[str, dict[str, str]] = {}
    with OVERRIDES.open(encoding="utf-8-sig", newline="") as handle:
        rows = (line for line in handle if not line.lstrip().startswith("#"))
        for row in csv.DictReader(rows):
            overrides[row["icao"]] = row
    return overrides


def fetch(url: str, name: str, *, offline: bool, refresh: bool) -> bytes:
    """Скачивает с кэшированием: повторная сборка не бьёт по чужому серверу."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / name
    if cached.exists() and not refresh:
        return cached.read_bytes()
    if offline:
        raise SystemExit(f"нет кэша {cached}, а запуск с --offline")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
        payload: bytes = response.read()
    cached.write_bytes(payload)
    return payload


def load_ourairports(*, offline: bool, refresh: bool) -> list[dict[str, str]]:
    raw = fetch(OURAIRPORTS_URL, "ourairports.csv", offline=offline, refresh=refresh)
    return list(csv.DictReader(raw.decode("utf-8").splitlines()))


def load_openflights_timezones(*, offline: bool, refresh: bool) -> dict[str, str]:
    raw = fetch(OPENFLIGHTS_URL, "openflights.dat", offline=offline, refresh=refresh)
    zones: dict[str, str] = {}
    for row in csv.reader(raw.decode("utf-8").splitlines()):
        if len(row) > 11 and row[5] not in ("", NULL) and row[11] not in ("", NULL):
            zones[row[5]] = row[11]
    return zones


def select(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Крупные аэропорты мира, средние в СНГ и узлы деловой авиации."""
    chosen: dict[str, dict[str, str]] = {}
    for row in rows:
        icao = row["icao_code"]
        if not icao or len(icao) != 4 or row["type"] == "closed":
            continue
        if not row["latitude_deg"] or not row["longitude_deg"]:
            continue
        big = row["type"] == "large_airport"
        cis_medium = row["type"] == "medium_airport" and row["iso_country"] in CIS
        if big or cis_medium or icao in BUSINESS_AVIATION:
            chosen[icao] = row
    return [chosen[icao] for icao in sorted(chosen)]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


def resolve_timezones(
    selected: list[dict[str, str]],
    known: dict[str, str],
    all_rows: list[dict[str, str]],
) -> dict[str, str]:
    """Зона из OpenFlights, иначе — у ближайшего аэропорта той же страны."""
    by_country: dict[str, list[tuple[float, float, str]]] = {}
    for row in all_rows:
        zone = known.get(row["icao_code"])
        if zone and row["latitude_deg"] and row["longitude_deg"]:
            by_country.setdefault(row["iso_country"], []).append(
                (float(row["latitude_deg"]), float(row["longitude_deg"]), zone)
            )

    resolved: dict[str, str] = {}
    unresolved: list[str] = []
    for row in selected:
        icao = row["icao_code"]
        zone = known.get(icao)
        if zone:
            resolved[icao] = zone
            continue
        neighbours = by_country.get(row["iso_country"])
        if not neighbours:
            fallback = SINGLE_ZONE_COUNTRY.get(row["iso_country"])
            if fallback:
                resolved[icao] = fallback
            else:
                unresolved.append(icao)
            continue
        lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
        nearest = min(neighbours, key=lambda n: haversine_km(lat, lon, n[0], n[1]))
        resolved[icao] = nearest[2]
    if unresolved:
        print(f"! зона не определена, аэропорт пропущен: {', '.join(unresolved)}", file=sys.stderr)
    return resolved


def _sparql(query: str) -> dict[str, Any]:
    """Запрос к Wikidata с ожиданием при ограничении частоты."""
    url = WIKIDATA_URL + "?" + urllib.parse.urlencode({"query": query, "format": "json"})
    headers = {"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"}
    delay = 70
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=300) as response:  # noqa: S310
                result: dict[str, Any] = json.load(response)
                return result
        except (urllib.error.HTTPError, urllib.error.URLError) as error:  # noqa: PERF203
            code = getattr(error, "code", 0)
            if (code and code not in (429, 500, 502, 503, 504)) or attempt == 2:
                raise
            print(f"  Wikidata недоступна ({code or error}), повтор через {delay} с")
            time.sleep(delay)
    raise RuntimeError("Wikidata не ответила")


def wikidata_names(icaos: list[str], *, offline: bool) -> dict[str, dict[str, str]]:
    """Необязательное дополнение: наименования из Wikidata.

    Служба ограничивает частоту запросов и регулярно бывает недоступна, поэтому
    результат складывается в кэш, а сбой не валит сборку: справочник остаётся
    с английскими наименованиями и выверенным наложением.
    """
    cached = CACHE / "wikidata-names.json"
    data: dict[str, dict[str, str]] = {}
    if cached.exists():
        data = json.loads(cached.read_text(encoding="utf-8"))
    missing = [code for code in icaos if code not in data]
    if not missing:
        return data
    if offline:
        print(f"! без сети: наименований нет для {len(missing)} аэропортов", file=sys.stderr)
        return data

    chunk_size = 300
    for start in range(0, len(missing), chunk_size):
        chunk = missing[start : start + chunk_size]
        values = " ".join(f'"{code}"' for code in chunk)
        query = f"""
        SELECT ?icao ?nameRu ?nameEn ?cityRu ?cityEn WHERE {{
          VALUES ?icao {{ {values} }}
          ?airport wdt:P239 ?icao .
          OPTIONAL {{ ?airport rdfs:label ?nameRu FILTER(lang(?nameRu) = "ru") }}
          OPTIONAL {{ ?airport rdfs:label ?nameEn FILTER(lang(?nameEn) = "en") }}
          OPTIONAL {{
            ?airport wdt:P931 ?city .
            OPTIONAL {{ ?city rdfs:label ?cityRu FILTER(lang(?cityRu) = "ru") }}
            OPTIONAL {{ ?city rdfs:label ?cityEn FILTER(lang(?cityEn) = "en") }}
          }}
        }}"""
        try:
            payload = _sparql(query)
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as error:
            print(f"! Wikidata недоступна ({error}), дополнение пропущено", file=sys.stderr)
            return data
        for binding in payload["results"]["bindings"]:
            code = binding["icao"]["value"]
            entry = data.setdefault(code, {})
            for key in ("nameRu", "nameEn", "cityRu", "cityEn"):
                value = binding.get(key, {}).get("value", "")
                if value and not entry.get(key):
                    entry[key] = value
        for code in chunk:
            data.setdefault(code, {})
        cached.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  наименования: {min(start + chunk_size, len(missing))} из {len(missing)}")
    return data


def build(*, offline: bool, refresh: bool, use_wikidata: bool) -> None:
    rows = load_ourairports(offline=offline, refresh=refresh)
    zones_known = load_openflights_timezones(offline=offline, refresh=refresh)
    selected = select(rows)
    print(f"выбрано аэропортов: {len(selected)}")

    zones = resolve_timezones(selected, zones_known, rows)
    from_openflights = sum(1 for row in selected if row["icao_code"] in zones_known)
    print(
        f"зона из OpenFlights: {from_openflights}, "
        f"по ближайшему аэропорту: {len(zones) - from_openflights}"
    )

    curated = load_overrides()
    missing_curated = sorted(set(curated) - {row["icao_code"] for row in selected})
    if missing_curated:
        print(f"! наложение ссылается на отсутствующие аэропорты: {missing_curated}", file=sys.stderr)

    names: dict[str, dict[str, str]] = {}
    if use_wikidata:
        names = wikidata_names([row["icao_code"] for row in selected], offline=offline)
    with_ru = sum(1 for code in zones if code in curated or names.get(code, {}).get("nameRu"))
    corrected = sum(
        1
        for code, row in curated.items()
        if code in zones and row["timezone"] != zones[code]
    )
    print(f"русское наименование: {with_ru} из {len(zones)} (выверено вручную: {len(curated)})")
    print(f"часовая зона исправлена наложением: {corrected}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with OUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(
            [
                "icao", "iata", "name_ru", "name_en", "city_ru", "city_en",
                "country", "timezone", "lat", "lon", "elevation_ft", "is_coordinated",
            ]
        )
        for row in selected:
            icao = row["icao_code"]
            zone = zones.get(icao)
            if not zone:
                continue
            wiki = names.get(icao, {})
            override = curated.get(icao, {})
            name_en = row["name"]
            city_en = row["municipality"] or wiki.get("cityEn") or ""
            # Выверенное наложение имеет приоритет и над набором, и над дополнением.
            name_ru = override.get("name_ru") or wiki.get("nameRu") or name_en
            city_ru = override.get("city_ru") or wiki.get("cityRu") or city_en
            zone = override.get("timezone") or zone
            writer.writerow(
                [
                    icao,
                    row["iata_code"],
                    name_ru,
                    name_en,
                    city_ru,
                    city_en,
                    row["iso_country"],
                    zone,
                    f'{float(row["latitude_deg"]):.6f}',
                    f'{float(row["longitude_deg"]):.6f}',
                    row["elevation_ft"] or "0",
                    "true" if icao in COORDINATED else "false",
                ]
            )
            written += 1
    print(f"записано в {OUT.relative_to(ROOT)}: {written}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Сборка справочника аэропортов")
    parser.add_argument("--offline", action="store_true", help="только кэш, без сети")
    parser.add_argument("--refresh", action="store_true", help="перекачать исходные наборы")
    parser.add_argument(
        "--wikidata", action="store_true", help="дополнить наименования из Wikidata"
    )
    args = parser.parse_args()
    build(offline=args.offline, refresh=args.refresh, use_wikidata=args.wikidata)


if __name__ == "__main__":
    main()
