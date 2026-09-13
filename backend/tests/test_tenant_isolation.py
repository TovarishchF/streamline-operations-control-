"""Изоляция данных порталов `[ТЗ 3.5]` (`BACKEND.md § 3.7`).

Критерий приёмки M3: «под ролью «Клиент» запрос чужого рейса возвращает 404,
списочный эндпоинт не отдаёт чужие записи». Рейсы появятся на M4, поэтому
механизм проверяется на парке воздушных судов: у борта есть клиент-оператор,
и это первая сущность, к которой портал клиента получает доступ.

Тест на протечку обязателен для каждого эндпоинта, доступного порталам
(`CLAUDE.md § 3` п. 11). Здесь проверяется и списочный эндпоинт, и карточка:
фильтр в `get_queryset()` закрывает оба, фильтр в проверке объекта — только
карточку.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest
from django.urls import reverse

from accounts.models import Role, User
from catalog.models import AircraftType
from core.api.viewsets import TenantScopedMixin
from core.models import DataSource
from fleet.models import Aircraft

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Client, Vendor


@pytest.fixture
def aircraft_type(db: None) -> AircraftType:
    return AircraftType.objects.create(
        icao_type="CL60",
        name_ru="Bombardier Challenger 605",
        name_en="Bombardier Challenger 605",
        category="heavy",
        seats=12,
        cruise_speed_kts=459,
        turnaround_min=75,
        data_source=DataSource.IMPORTED,
    )


@pytest.fixture
def own_aircraft(aircraft_type: AircraftType, client_alpha: Client) -> Aircraft:
    return Aircraft.objects.create(
        registration="RA-67231",
        type=aircraft_type,
        operator=client_alpha,
        home_base_icao="UUWW",
    )


@pytest.fixture
def other_aircraft(aircraft_type: AircraftType, client_beta: Client) -> Aircraft:
    return Aircraft.objects.create(
        registration="RA-67899",
        type=aircraft_type,
        operator=client_beta,
        home_base_icao="ULLI",
    )


@pytest.mark.django_db
class TestClientPortalIsolation:
    def test_list_hides_other_clients_aircraft(
        self,
        as_role: Callable[..., APIClient],
        client_alpha: Client,
        own_aircraft: Aircraft,
        other_aircraft: Aircraft,
    ) -> None:
        api = as_role(Role.CLIENT, client=client_alpha)

        response = api.get(reverse("v1:aircraft-list"))

        assert response.status_code == 200
        registrations = [item["registration"] for item in response.data["data"]]
        assert registrations == [own_aircraft.registration]
        assert other_aircraft.registration not in registrations

    def test_foreign_record_answers_404_not_403(
        self,
        as_role: Callable[..., APIClient],
        client_alpha: Client,
        other_aircraft: Aircraft,
    ) -> None:
        """404, а не 403: существование чужой записи не раскрывается (ADR-003)."""
        api = as_role(Role.CLIENT, client=client_alpha)

        response = api.get(reverse("v1:aircraft-detail", args=[other_aircraft.pk]))

        assert response.status_code == 404
        assert response.data["error"]["code"] == "NOT_FOUND"

    def test_own_record_is_available(
        self,
        as_role: Callable[..., APIClient],
        client_alpha: Client,
        own_aircraft: Aircraft,
    ) -> None:
        api = as_role(Role.CLIENT, client=client_alpha)

        response = api.get(reverse("v1:aircraft-detail", args=[own_aircraft.pk]))

        assert response.status_code == 200
        assert response.data["registration"] == own_aircraft.registration

    def test_total_in_meta_counts_only_own_records(
        self,
        as_role: Callable[..., APIClient],
        client_alpha: Client,
        own_aircraft: Aircraft,
        other_aircraft: Aircraft,
    ) -> None:
        """Счётчик тоже протекает: по нему видно, сколько записей у других."""
        api = as_role(Role.CLIENT, client=client_alpha)

        response = api.get(reverse("v1:aircraft-list"))

        assert response.data["meta"]["total"] == 1


@pytest.mark.django_db
class TestVendorPortalIsolation:
    def test_vendor_has_no_access_to_the_fleet_at_all(
        self,
        as_role: Callable[..., APIClient],
        vendor_alpha: Vendor,
        own_aircraft: Aircraft,
    ) -> None:
        """Парк клиента поставщика не касается: в матрице `SPEC § 2.2` прочерк.

        Отказ происходит раньше фильтрации — по праву. Проверять здесь пустую
        выборку было бы проверкой не того рубежа.
        """
        api = as_role(Role.VENDOR, vendor=vendor_alpha)

        assert api.get(reverse("v1:aircraft-list")).status_code == 403


@pytest.mark.django_db
class TestDefaultDenyScope:
    """Вьюсет, забывший объявить поле связи, не должен отдавать всё подряд."""

    def test_queryset_is_empty_when_the_tenant_field_is_not_declared(
        self,
        make_user: Callable[..., User],
        client_alpha: Client,
        own_aircraft: Aircraft,
        other_aircraft: Aircraft,
    ) -> None:
        class _Source:
            def get_queryset(self) -> object:
                return Aircraft.objects.all()

        class _Unscoped(TenantScopedMixin, _Source):
            tenant_client_field = None

        view = _Unscoped()
        view.request = SimpleNamespace(  # type: ignore[attr-defined]
            user=make_user(Role.CLIENT, client=client_alpha)
        )

        assert list(view.get_queryset()) == []


@pytest.mark.django_db
class TestStaffRolesAreNotScoped:
    def test_dispatcher_sees_every_aircraft(
        self,
        as_role: Callable[..., APIClient],
        own_aircraft: Aircraft,
        other_aircraft: Aircraft,
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.get(reverse("v1:aircraft-list"))

        assert response.data["meta"]["total"] == 2


@pytest.mark.django_db
class TestPortalUserIntegrity:
    def test_client_user_without_client_is_rejected_by_the_database(
        self, make_user: Callable[..., object]
    ) -> None:
        """Пользователь портала без контрагента не ограничен ничем.

        Проверку легко обойти в коде, поэтому она продублирована ограничением
        в базе — тест бьёт именно по нему.
        """
        from django.db.utils import IntegrityError

        with pytest.raises(IntegrityError):
            make_user(Role.CLIENT)
