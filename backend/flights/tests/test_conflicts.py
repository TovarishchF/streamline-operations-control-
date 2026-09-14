"""Конфликты расписания `[ТЗ 3.1.1]`.

Критерий приёмки M4: «конфликт расписания фиксируется с причиной, причина
попадает в аудит». Конфликт не запрещает сохранение: запрет заставил бы
обходить систему, а обойдённая система перестаёт быть источником истины.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import pytest

from audit.models import AuditEntry
from core import clock
from core.models import DataSource
from fleet.models import Aircraft, AircraftApproval, AircraftStatus
from flights.models import Flight, FlightStatus
from flights.services import conflicts, planning

if TYPE_CHECKING:
    from accounts.models import User
    from catalog.models import Airport
    from counterparties.models import Client


def _flight(client: Client, aircraft: Aircraft | None, hours_from_now: int) -> Flight:
    return planning.create_flight(
        client=client,
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=clock.now() + timedelta(hours=hours_from_now),
        aircraft=aircraft,
    )


@pytest.mark.django_db
class TestAircraftState:
    def test_aog_aircraft_is_a_conflict(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        Aircraft.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.AOG)
        aircraft.refresh_from_db()

        found = conflicts.detect(_flight(client_alpha, aircraft, 6))

        assert [item.kind for item in found] == ["aircraft_aog"]
        assert aircraft.registration in found[0].message

    def test_maintenance_is_a_conflict(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        Aircraft.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.MAINTENANCE)
        aircraft.refresh_from_db()

        found = conflicts.detect(_flight(client_alpha, aircraft, 6))

        assert [item.kind for item in found] == ["aircraft_maintenance"]

    def test_serviceable_aircraft_is_clean(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        assert conflicts.detect(_flight(client_alpha, aircraft, 6)) == []


@pytest.mark.django_db
class TestOverlap:
    def test_flights_of_one_aircraft_must_not_intersect(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        first = _flight(client_alpha, aircraft, 6)
        second = _flight(client_alpha, aircraft, 6)

        found = [item for item in conflicts.detect(second) if item.kind == "overlap"]

        assert len(found) == 1
        assert first.number in found[0].message
        assert found[0].related_flight_id == first.pk

    def test_cancelled_flight_does_not_occupy_the_aircraft(
        self,
        airports: dict[str, Airport],
        client_alpha: Client,
        aircraft: Aircraft,
        dispatcher: User,
    ) -> None:
        from flights.services import transitions

        first = _flight(client_alpha, aircraft, 6)
        transitions.apply_transition(
            first, "cancel", actor=dispatcher, reason_code="client_request"
        )

        second = _flight(client_alpha, aircraft, 6)

        assert [item for item in conflicts.detect(second) if item.kind == "overlap"] == []

    def test_different_aircraft_do_not_conflict(
        self,
        airports: dict[str, Airport],
        client_alpha: Client,
        aircraft: Aircraft,
        aircraft_type: object,
    ) -> None:
        other = Aircraft.objects.create(
            registration="RA-67899", type=aircraft.type, home_base_icao="UUWW"
        )
        _flight(client_alpha, aircraft, 6)
        second = _flight(client_alpha, other, 6)

        assert [item for item in conflicts.detect(second) if item.kind == "overlap"] == []


@pytest.mark.django_db
class TestTurnaround:
    def test_too_short_gap_is_a_conflict(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        """Минимум берётся из типа ВС: тяжёлому борту нужно больше времени."""
        first = _flight(client_alpha, aircraft, 6)
        # Следующий рейс через полчаса после прилёта, минимум для CL60 — 75 минут.
        second = planning.create_flight(
            client=client_alpha,
            dep_icao="ULLI",
            arr_icao="UUWW",
            std_utc=first.sta_utc + timedelta(minutes=30),
            aircraft=aircraft,
        )

        found = [item for item in conflicts.detect(second) if item.kind == "turnaround"]

        assert len(found) == 1
        assert "75" in found[0].message

    def test_sufficient_gap_is_clean(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        first = _flight(client_alpha, aircraft, 6)
        second = planning.create_flight(
            client=client_alpha,
            dep_icao="ULLI",
            arr_icao="UUWW",
            std_utc=first.sta_utc + timedelta(hours=3),
            aircraft=aircraft,
        )

        assert [item for item in conflicts.detect(second) if item.kind == "turnaround"] == []


@pytest.mark.django_db
class TestApprovals:
    def test_approval_expiring_before_the_flight_is_a_conflict(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        """Допуск проверяется на дату рейса, а не на сегодня (ADR-027)."""
        AircraftApproval.objects.create(
            aircraft=aircraft,
            kind="RVSM",
            number="RVSM-12345",
            valid_from=clock.now() - timedelta(days=365),
            valid_to=clock.now() + timedelta(days=2),
            data_source=DataSource.USER,
        )

        found = [
            item
            for item in conflicts.detect(_flight(client_alpha, aircraft, 24 * 5))
            if item.kind == "approval_expired"
        ]

        assert len(found) == 1
        assert "RVSM" in found[0].message

    def test_valid_approval_is_clean(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        AircraftApproval.objects.create(
            aircraft=aircraft,
            kind="RVSM",
            valid_from=clock.now() - timedelta(days=365),
            valid_to=clock.now() + timedelta(days=365),
            data_source=DataSource.USER,
        )

        found = [
            item
            for item in conflicts.detect(_flight(client_alpha, aircraft, 6))
            if item.kind == "approval_expired"
        ]

        assert found == []


@pytest.mark.django_db
class TestAuditRecord:
    def test_conflict_reason_reaches_the_audit(
        self,
        airports: dict[str, Airport],
        client_alpha: Client,
        aircraft: Aircraft,
        dispatcher: User,
    ) -> None:
        """Тот самый критерий приёмки."""
        Aircraft.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.AOG)
        aircraft.refresh_from_db()

        flight = planning.create_flight(
            client=client_alpha,
            dep_icao="UUWW",
            arr_icao="ULLI",
            std_utc=clock.now() + timedelta(hours=6),
            aircraft=aircraft,
            actor=dispatcher,
        )

        entry = AuditEntry.objects.get(entity_id=flight.pk, action="schedule_conflict")
        assert "AOG" in entry.comment
        assert entry.after is not None
        assert entry.after["conflicts"][0]["kind"] == "aircraft_aog"

    def test_clean_flight_writes_no_conflict_entry(
        self,
        airports: dict[str, Airport],
        client_alpha: Client,
        aircraft: Aircraft,
        dispatcher: User,
    ) -> None:
        flight = _flight(client_alpha, aircraft, 6)

        assert not AuditEntry.objects.filter(
            entity_id=flight.pk, action="schedule_conflict"
        ).exists()


@pytest.mark.django_db
class TestClosedFlights:
    def test_completed_flight_has_no_conflicts(
        self, airports: dict[str, Airport], client_alpha: Client, aircraft: Aircraft
    ) -> None:
        Aircraft.objects.filter(pk=aircraft.pk).update(status=AircraftStatus.AOG)
        aircraft.refresh_from_db()
        flight = _flight(client_alpha, aircraft, 6)
        Flight.objects.filter(pk=flight.pk).update(status=FlightStatus.COMPLETED)
        flight.refresh_from_db()

        assert conflicts.detect(flight) == []
