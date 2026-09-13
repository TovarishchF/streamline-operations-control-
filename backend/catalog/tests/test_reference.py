"""Проверка справочных данных `[ТЗ этап 3]`.

Критерий приёмки M3: «справочник аэропортов загружен, часовые зоны корректны
для 60 аэропортов». Здесь он проверяется в трёх слоях:

* зона существует в базе IANA — иначе `ZoneInfo` не построится и локальное
  время рейса посчитать нечем;
* смещение зоны согласуется с долготой — грубая, но действенная сеть:
  ошибка в зоне обычно даёт расхождение в несколько часов;
* для аэропортов из выверенного вручную наложения зона совпадает в точности.
  Их больше шестидесяти, и это именно те аэропорты, где ошибка дороже всего:
  рабочий регион заказчика.
"""

from __future__ import annotations

import csv
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

import pytest
from django.conf import settings
from django.core.management import call_command

from catalog.models import AircraftType, Airport, Service, ServiceCategory, VatRate
from core import clock
from core.models import DataSource

REFERENCE = Path(settings.SHARED_DIR) / "reference"

# Смещение часовой зоны отличается от солнечного времени: зоны нарезаны по
# административным границам, а не по меридианам. Три часа — предел, за которым
# расхождение перестаёт быть политическим и означает ошибку в данных.
MAX_OFFSET_DEVIATION_H = 3.0


def _airports() -> list[dict[str, str]]:
    with (REFERENCE / "airports.csv").open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _overrides() -> dict[str, dict[str, str]]:
    with (REFERENCE / "airport-overrides.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = (line for line in handle if not line.lstrip().startswith("#"))
        return {row["icao"]: row for row in csv.DictReader(rows)}


class TestAirportsFile:
    """Проверки самого файла: работают без базы."""

    def test_file_is_not_empty(self) -> None:
        rows = _airports()
        assert len(rows) > 1000, "справочник подозрительно мал, проверьте сборку"

    def test_icao_codes_are_unique_and_well_formed(self) -> None:
        codes = [row["icao"] for row in _airports()]
        assert len(codes) == len(set(codes))
        assert all(len(code) == 4 and code.isalpha() and code.isupper() for code in codes)

    def test_every_timezone_exists_in_tzdb(self) -> None:
        known = available_timezones()
        unknown = sorted({row["timezone"] for row in _airports()} - known)
        assert unknown == [], f"зон нет в базе IANA: {unknown}"

    def test_timezone_offset_agrees_with_longitude(self) -> None:
        now = clock.now()
        suspicious: list[str] = []
        for row in _airports():
            offset = ZoneInfo(row["timezone"]).utcoffset(now)
            assert offset is not None
            hours = offset.total_seconds() / 3600
            deviation = abs(hours - float(row["lon"]) / 15)
            if deviation > 12:  # переход через линию перемены дат
                deviation = 24 - deviation
            if deviation > MAX_OFFSET_DEVIATION_H:
                suspicious.append(f'{row["icao"]} {row["timezone"]} {hours:+.0f} ч')
        assert suspicious == [], f"зона расходится с долготой: {suspicious}"

    def test_verified_airports_keep_their_timezone(self) -> None:
        """Выверенный вручную перечень применён и не потерян при пересборке."""
        overrides = _overrides()
        assert len(overrides) >= 60, "выверено меньше шестидесяти аэропортов"

        rows = {row["icao"]: row for row in _airports()}
        mismatched = [
            f'{icao}: в справочнике {rows[icao]["timezone"]}, выверено {row["timezone"]}'
            for icao, row in overrides.items()
            if icao in rows and rows[icao]["timezone"] != row["timezone"]
        ]
        assert mismatched == [], mismatched

        missing = sorted(set(overrides) - set(rows))
        assert missing == [], f"выверенные аэропорты пропали из справочника: {missing}"

    def test_verified_airports_have_russian_names(self) -> None:
        rows = {row["icao"]: row for row in _airports()}
        overrides = _overrides()
        without = [
            icao
            for icao, row in overrides.items()
            if rows[icao]["name_ru"] != row["name_ru"]
        ]
        assert without == []

    def test_moscow_airports_are_coordinated(self) -> None:
        """ADR-026: у координируемого аэропорта признак проставлен."""
        rows = {row["icao"]: row for row in _airports()}
        for icao in ("UUEE", "UUDD", "UUWW", "EGLL", "LFPG"):
            assert rows[icao]["is_coordinated"] == "true", icao


@pytest.mark.django_db
class TestSeedReference:
    def test_loads_all_datasets(self) -> None:
        call_command("seed_reference")

        assert Airport.objects.count() == len(_airports())
        assert AircraftType.objects.count() > 40
        assert VatRate.objects.count() >= 4
        assert Service.objects.count() > 20

    def test_repeated_run_changes_nothing(self) -> None:
        """Идемпотентность: развёртывание и обновление справочника безопасны."""
        call_command("seed_reference", only="aircraft-types,vat-rates,services")
        before = {
            (obj.pk, obj.version) for obj in AircraftType.objects.all()
        } | {(obj.pk, obj.version) for obj in VatRate.objects.all()}

        call_command("seed_reference", only="aircraft-types,vat-rates,services")
        after = {
            (obj.pk, obj.version) for obj in AircraftType.objects.all()
        } | {(obj.pk, obj.version) for obj in VatRate.objects.all()}

        assert before == after, "повторный запуск переписал записи"

    def test_reference_data_is_imported_not_synthetic(self) -> None:
        """`CLAUDE.md § 4`: общедоступные справочные данные — настоящие."""
        call_command("seed_reference", only="vat-rates")
        assert set(VatRate.objects.values_list("data_source", flat=True)) == {DataSource.IMPORTED}
        assert not VatRate.objects.filter(is_demo=True).exists()

    def test_service_categories_are_exactly_those_in_the_specification(self) -> None:
        """ТЗ 3.2.1 перечисляет шесть категорий. Седьмой быть не может."""
        call_command("seed_reference", only="services")
        loaded = set(Service.objects.values_list("category", flat=True))
        assert loaded == set(ServiceCategory.values)

    def test_vat_percent_is_decimal_not_float(self) -> None:
        call_command("seed_reference", only="vat-rates")
        rate = VatRate.objects.get(code="VAT20")
        assert str(rate.percent) == "20.0000"
