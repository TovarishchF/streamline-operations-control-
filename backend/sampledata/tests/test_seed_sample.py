"""Набор генератора данных: правила честности `CLAUDE.md § 4`.

Проверяется не «команда отработала», а то, что данные генератора остаются
отличимыми от введённых людьми: записи помечены, происхождение проставлено,
действия генератора не выдаются за действия людей, очистка не трогает чужое.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from django.core.management import call_command

from accounts.models import Role, User
from audit.models import AuditEntry, AuditSource
from catalog.models import AircraftType, Airport, Service, ServiceCategory, ServiceUnit, VendorPrice
from core.clock import now
from core.exceptions import SampleDataDisabled
from core.models import DataSource
from counterparties.models import Client, Contact, Vendor
from fleet.models import Aircraft, AircraftStatus
from sampledata import services as sample
from sampledata.purge import GENERATED_EMAIL_DOMAIN

if TYPE_CHECKING:
    from collections.abc import Callable


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
def test_command_refuses_when_generator_is_off(reference: None, settings: object) -> None:
    """ADR-008: в рабочей базе придуманные контрагенты недопустимы."""
    with pytest.raises(SampleDataDisabled):
        call_command("seed_sample")


@pytest.mark.django_db
class TestGeneratedSet:
    @pytest.fixture(autouse=True)
    def _sample_data(self, settings: object, reference: None) -> None:
        settings.SAMPLE_DATA = True  # type: ignore[attr-defined]
        call_command("seed_sample", seed=20260913)

    def test_every_record_is_marked_as_generated(self) -> None:
        assert not Client.objects.filter(is_generated=False).exists()
        assert not Vendor.objects.filter(is_generated=False).exists()
        assert not Aircraft.objects.filter(is_generated=False).exists()

    def test_origin_is_synthetic_not_live(self) -> None:
        """Данные генератора — `synthetic`, и ничем другим притворяться не должны."""
        sources = set(Aircraft.objects.values_list("data_source", flat=True))
        assert sources == {DataSource.SYNTHETIC}

    def test_generator_actions_are_not_passed_off_as_human(self) -> None:
        entries = AuditEntry.objects.filter(source=AuditSource.SEED)

        assert entries.exists()
        assert set(entries.values_list("actor_name", flat=True)) == {"Система (генератор данных)"}
        assert not entries.filter(is_generated=False).exists()

    def test_users_live_in_the_generator_domain(self) -> None:
        """По зоне адреса очистка находит пользователей генератора."""
        users = User.objects.filter(email__endswith=f"@{GENERATED_EMAIL_DOMAIN}")
        assert users.filter(username="karpov").exists()
        assert not users.filter(username__contains=".").exists()

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

        call_command("seed_sample", seed=20260913)

        assert Aircraft.objects.count() == before

    def test_purge_removes_generated_records(self) -> None:
        call_command("seed_sample", purge=True)

        assert not Client.objects.filter(is_generated=True).exists()
        assert not Aircraft.objects.filter(is_generated=True).exists()
        assert not User.objects.filter(email__endswith=f"@{GENERATED_EMAIL_DOMAIN}").exists()

    def test_purge_keeps_people(self, make_user: Callable[..., User]) -> None:
        """Пользователь, заведённый человеком, переживает очистку (ADR-016)."""
        person = make_user(Role.DISPATCHER, suffix="person")

        call_command("seed_sample", purge=True)

        assert User.objects.filter(pk=person.pk).exists()

    def test_price_added_by_a_person_survives_with_its_vendor(self) -> None:
        """ADR-041: цена человека у поставщика набора не уходит вместе с ним.

        Раньше связь `CASCADE` уносила её молча. Теперь поставщик остаётся,
        и очистка называет его и причину.
        """
        vendor = Vendor.objects.filter(is_generated=True).order_by("name").first()
        assert vendor is not None
        price = _price_by_a_person(vendor)

        outcome = sample.purge()

        assert VendorPrice.objects.filter(pk=price.pk).exists()
        assert list(Vendor.objects.filter(is_generated=True)) == [vendor]
        kept = {item.id: item for item in outcome.kept}
        assert "Цена поставщика" in kept[vendor.pk].reason
        assert not Client.objects.filter(is_generated=True).exists()

    def test_portal_user_of_a_generated_client_does_not_break_the_purge(
        self, make_user: Callable[..., User]
    ) -> None:
        """ADR-041: связь `PROTECT` пользователя на клиента набора обрывала всю очистку."""
        client = Client.objects.filter(is_generated=True).order_by("name").first()
        assert client is not None
        person = make_user(Role.CLIENT, suffix="portal", client=client)

        outcome = sample.purge()

        assert User.objects.filter(pk=person.pk, client=client).exists()
        assert [item.id for item in outcome.kept] == [client.pk]
        # Рейсы, борта и документы клиента — записи набора, на них люди не ссылаются.
        assert not Aircraft.objects.filter(is_generated=True).exists()

    def test_reset_takes_what_the_purge_kept(self) -> None:
        """Пересоздание после очистки берёт оставленного поставщика как есть.

        Второго экземпляра нет, записи набора у него созданы заново — цена
        человека их не заменяет, но и соседа на свой период не получает.
        """
        vendor = (
            Vendor.objects.filter(
                is_generated=True,
                specializations__contains=["transport"],
                coverage_airports__contains=["UUWW"],
            )
            .order_by("name")
            .first()
        )
        assert vendor is not None
        price = _price_by_a_person(vendor, code="TRN_CREW", category=ServiceCategory.TRANSPORT)
        other = _imported_service("TRN_VIP", ServiceCategory.TRANSPORT)

        outcome = sample.reset(seed=20260913)

        assert Vendor.objects.filter(name=vendor.name).count() == 1
        assert VendorPrice.objects.filter(pk=price.pk).exists()
        assert [item.id for item in outcome.kept] == [vendor.pk]
        assert Contact.objects.filter(vendor=vendor, is_generated=True).exists()
        assert VendorPrice.objects.filter(vendor=vendor, service=other, is_generated=True).exists()
        overlapping = VendorPrice.objects.filter(
            vendor=vendor,
            service=price.service,
            airport_icao=price.airport_icao,
            valid_from__lt=price.valid_to,
            valid_to__gt=price.valid_from,
        )
        assert list(overlapping) == [price]

    def test_reset_keeps_the_generator_staff_accounts(self) -> None:
        """Администратор набора, нажавший «Пересоздать», не теряет сеанс."""
        accounts = User.objects.filter(
            email__endswith=f"@{GENERATED_EMAIL_DOMAIN}", client=None, vendor=None
        )
        before = set(accounts.values_list("pk", flat=True))
        assert accounts.filter(role=Role.ADMIN).exists()

        sample.reset(seed=20260913)

        assert set(accounts.values_list("pk", flat=True)) == before

    def test_nothing_is_kept_when_people_refer_to_nothing(self) -> None:
        assert sample.purge().kept == []

    def test_purge_keeps_the_audit_trail(self) -> None:
        """Журнал только пополняется — удалять из него нельзя и генератору."""
        before = AuditEntry.objects.count()

        call_command("seed_sample", purge=True)

        assert AuditEntry.objects.count() >= before


@pytest.mark.django_db
def test_generator_is_deterministic(reference: None, settings: object) -> None:
    """Одно зерно — один набор: снимки экранов должны воспроизводиться."""
    settings.SAMPLE_DATA = True  # type: ignore[attr-defined]

    call_command("seed_sample", seed=777)
    first = sorted(Aircraft.objects.values_list("registration", flat=True))

    call_command("seed_sample", purge=True)
    call_command("seed_sample", seed=777)
    second = sorted(Aircraft.objects.values_list("registration", flat=True))

    assert first == second


def _imported_service(code: str, category: str) -> Service:
    """Позиция каталога, как её загружает `seed_reference`."""
    return Service.objects.create(
        code=code,
        category=category,
        name_ru=code,
        name_en=code,
        unit=ServiceUnit.FLIGHT,
        data_source=DataSource.IMPORTED,
    )


def _price_by_a_person(
    vendor: Vendor, *, code: str = "HND_BASIC", category: str = ServiceCategory.HANDLING
) -> VendorPrice:
    """Цена, которую человек добавил поставщику из набора."""
    return VendorPrice.objects.create(
        vendor=vendor,
        service=_imported_service(code, category),
        airport_icao="UUWW",
        amount=Decimal("45000.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=1),
        valid_to=now() + timedelta(days=30),
    )
