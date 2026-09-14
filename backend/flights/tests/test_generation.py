"""Генерация серии из шаблона `[ТЗ 3.1.1]`.

Критерий приёмки M4: «шаблон на будни генерирует ожидаемое число рейсов,
время корректно для аэропорта с зоной, отличной от московской, и на переходе
летнего времени».

Переход летнего времени проверяется на европейской зоне: в России перехода
нет с 2014 года, и на московских аэропортах эта ошибка не проявляется вовсе.
"""

from __future__ import annotations

from datetime import date, time
from typing import TYPE_CHECKING

import pytest

from flights.models import Flight, FlightTemplate
from flights.services import generation

if TYPE_CHECKING:
    from accounts.models import User
    from catalog.models import AircraftType, Airport
    from counterparties.models import Client

WEEKDAYS = [1, 2, 3, 4, 5]


@pytest.fixture
def template(
    airports: dict[str, Airport], client_alpha: Client, aircraft_type: AircraftType
) -> FlightTemplate:
    return FlightTemplate.objects.create(
        organization=client_alpha.organization,
        name="Москва — Петербург, будни",
        client=client_alpha,
        aircraft_type=aircraft_type,
        dep_icao="UUWW",
        arr_icao="ULLI",
        dep_time_local=time(9, 30),
        weekdays=WEEKDAYS,
    )


@pytest.mark.django_db
class TestOccurrences:
    def test_only_weekdays_are_taken(self, template: FlightTemplate) -> None:
        """2026-03-02 — понедельник, 2026-03-15 — воскресенье."""
        moments = generation.occurrences(template, date(2026, 3, 2), date(2026, 3, 15))

        assert len(moments) == 10
        assert all(moment.isoweekday() in WEEKDAYS for moment in moments)

    def test_moscow_local_time_becomes_utc(self, template: FlightTemplate) -> None:
        """Москва круглый год UTC+3: 09:30 местного — 06:30Z."""
        moments = generation.occurrences(template, date(2026, 3, 2), date(2026, 3, 2))

        assert moments[0].hour == 6
        assert moments[0].minute == 30

    def test_novosibirsk_offset_differs_from_moscow(
        self, template: FlightTemplate, airports: dict[str, Airport]
    ) -> None:
        """Зона, отличная от московской: Новосибирск UTC+7, 09:30 → 02:30Z."""
        FlightTemplate.objects.filter(pk=template.pk).update(dep_icao="UNNT")
        template.refresh_from_db()

        moments = generation.occurrences(template, date(2026, 3, 2), date(2026, 3, 2))

        assert moments[0].hour == 2
        assert moments[0].minute == 30

    def test_daylight_saving_shifts_utc_within_one_series(
        self, template: FlightTemplate, airports: dict[str, Airport]
    ) -> None:
        """Одно местное время до и после перехода даёт разное UTC.

        Европа переводит часы в последнее воскресенье марта 2026 года —
        29 марта. До него Париж UTC+1, после UTC+2, поэтому 09:30 местного
        превращается сперва в 08:30Z, а затем в 07:30Z. Посчитать смещение
        один раз на серию — значит увести половину рейсов на час.
        """
        FlightTemplate.objects.filter(pk=template.pk).update(dep_icao="LFPB")
        template.refresh_from_db()

        before = generation.occurrences(template, date(2026, 3, 27), date(2026, 3, 27))
        after = generation.occurrences(template, date(2026, 3, 30), date(2026, 3, 30))

        assert before[0].hour == 8
        assert after[0].hour == 7

    def test_too_long_period_is_refused(self, template: FlightTemplate) -> None:
        """Серия на два года — почти всегда опечатка в датах."""
        with pytest.raises(generation.SeriesTooLong):
            generation.occurrences(template, date(2026, 1, 1), date(2028, 1, 1))


@pytest.mark.django_db
class TestGenerate:
    def test_creates_the_expected_number_of_flights(
        self, template: FlightTemplate, dispatcher: User
    ) -> None:
        created = generation.generate(
            template, date(2026, 3, 2), date(2026, 3, 15), actor=dispatcher
        )

        assert len(created) == 10
        assert Flight.objects.filter(template=template).count() == 10

    def test_repeated_generation_does_not_duplicate(
        self, template: FlightTemplate, dispatcher: User
    ) -> None:
        """Диспетчер продлевает серию с запасом — это нормальный сценарий."""
        generation.generate(template, date(2026, 3, 2), date(2026, 3, 8), actor=dispatcher)

        added = generation.generate(
            template, date(2026, 3, 2), date(2026, 3, 15), actor=dispatcher
        )

        assert len(added) == 5
        assert Flight.objects.filter(template=template).count() == 10

    def test_generated_flights_carry_the_route(
        self, template: FlightTemplate, dispatcher: User
    ) -> None:
        created = generation.generate(
            template, date(2026, 3, 2), date(2026, 3, 2), actor=dispatcher
        )

        flight = created[0]
        assert flight.distance_nm > 0
        assert flight.sta_utc > flight.std_utc
        assert flight.template_id == template.pk
