"""Демонстрационный набор: правила честности `CLAUDE.md § 4`.

Проверяется не «команда отработала», а то, что стенд остаётся опознаваемым
как стенд: записи помечены, происхождение проставлено, действия генератора
не выдаются за действия людей.
"""

from __future__ import annotations

import pytest
from django.core.management import call_command

from audit.models import AuditEntry, AuditSource
from catalog.models import AircraftType, Airport
from core.exceptions import DemoOnlyOperation
from core.models import DataSource
from counterparties.models import Client, Vendor
from fleet.models import Aircraft, AircraftStatus


@pytest.fixture
def reference(db: None) -> None:
    """Минимальный справочник: генератор опирается на настоящие коды."""
    Airport.objects.create(
        icao="UUWW",
        iata="VKO",
        name_ru="Внуково",
        name_en="Vnukovo",
        city_ru="Москва",
        city_en="Moscow",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.591531,
        lon=37.261486,
        data_source=DataSource.IMPORTED,
    )
    for code, category in (("CL60", "heavy"), ("C25B", "light"), ("AN26", "cargo")):
        AircraftType.objects.create(
            icao_type=code,
            name_ru=code,
            name_en=code,
            category=category,
            seats=8,
            cruise_speed_kts=450,
            turnaround_min=60,
            data_source=DataSource.IMPORTED,
        )


@pytest.mark.django_db
def test_command_refuses_outside_demo_mode(reference: None, settings: object) -> None:
    """ADR-008: в боевом режиме придуманные контрагенты недопустимы."""
    with pytest.raises(DemoOnlyOperation):
        call_command("seed_demo")


@pytest.mark.django_db
class TestGeneratedSet:
    @pytest.fixture(autouse=True)
    def _demo_mode(self, settings: object, reference: None) -> None:
        settings.DEMO_DATA = True  # type: ignore[attr-defined]
        call_command("seed_demo", seed=20260913)

    def test_every_record_is_marked_as_demonstration(self) -> None:
        assert not Client.objects.filter(is_demo=False).exists()
        assert not Vendor.objects.filter(is_demo=False).exists()
        assert not Aircraft.objects.filter(is_demo=False).exists()

    def test_origin_is_synthetic_not_live(self) -> None:
        """Данные генератора — `synthetic`, и ничем другим притворяться не должны."""
        sources = set(Aircraft.objects.values_list("data_source", flat=True))
        assert sources == {DataSource.SYNTHETIC}

    def test_generator_actions_are_not_passed_off_as_human(self) -> None:
        entries = AuditEntry.objects.filter(source=AuditSource.SEED)

        assert entries.exists()
        assert set(entries.values_list("actor_name", flat=True)) == {"System (демо-генератор)"}
        assert not entries.filter(is_demo=False).exists()

    def test_reference_data_is_not_invented(self) -> None:
        """Коды аэропортов и типов берутся из справочника, а не выдумываются."""
        bases = set(Aircraft.objects.values_list("home_base_icao", flat=True))
        known = set(Airport.objects.values_list("icao", flat=True))
        assert bases <= known

    def test_set_contains_an_unserviceable_aircraft(self) -> None:
        """Без неисправного борта не показать ни одного сценария срыва."""
        assert Aircraft.objects.filter(status=AircraftStatus.AOG).exists()
        assert Aircraft.objects.filter(status=AircraftStatus.MAINTENANCE).exists()

    def test_repeated_run_does_not_duplicate(self) -> None:
        before = Aircraft.objects.count()

        call_command("seed_demo", seed=20260913)

        assert Aircraft.objects.count() == before

    def test_purge_removes_demo_records(self) -> None:
        call_command("seed_demo", purge=True)

        assert not Client.objects.filter(is_demo=True).exists()
        assert not Aircraft.objects.filter(is_demo=True).exists()

    def test_purge_keeps_the_audit_trail(self) -> None:
        """Журнал только пополняется — удалять из него нельзя и генератору."""
        before = AuditEntry.objects.count()

        call_command("seed_demo", purge=True)

        assert AuditEntry.objects.count() >= before


@pytest.mark.django_db
def test_generator_is_deterministic(reference: None, settings: object) -> None:
    """Одно зерно — один набор: снимки экранов должны воспроизводиться."""
    settings.DEMO_DATA = True  # type: ignore[attr-defined]

    call_command("seed_demo", seed=777)
    first = sorted(Aircraft.objects.values_list("registration", flat=True))

    call_command("seed_demo", purge=True)
    call_command("seed_demo", seed=777)
    second = sorted(Aircraft.objects.values_list("registration", flat=True))

    assert first == second
