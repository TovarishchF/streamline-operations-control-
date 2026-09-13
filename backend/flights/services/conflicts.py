"""Детектор конфликтов расписания `[ТЗ 3.1.1]`.

Конфликт — это не ошибка ввода, а повод для решения диспетчера: рейс
сохраняется, конфликт показывается. Запрет сохранения заставил бы обходить
систему, а обойдённая система перестаёт быть источником истины.

Каждый конфликт несёт причину текстом: «пересечение» без указания, с чем
именно, диспетчеру ничего не даёт.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING

from django.db.models import Q
from django.utils.translation import gettext as _

from fleet.models import AircraftStatus
from flights.models import Flight, FlightStatus

if TYPE_CHECKING:
    from collections.abc import Iterable

# Статусы, в которых рейс больше не занимает борт.
CLOSED_STATUSES = (FlightStatus.CANCELLED, FlightStatus.COMPLETED)


@dataclass(frozen=True)
class Conflict:
    kind: str
    message: str
    related_flight_id: str | None = None


def detect(flight: Flight) -> list[Conflict]:
    """Все конфликты рейса на текущий момент."""
    if flight.status in CLOSED_STATUSES:
        return []

    conflicts: list[Conflict] = []
    conflicts.extend(_aircraft_state(flight))
    if flight.aircraft_id is not None:
        conflicts.extend(_overlaps(flight))
        conflicts.extend(_turnaround(flight))
        conflicts.extend(_expired_approvals(flight))
    return conflicts


def _aircraft_state(flight: Flight) -> Iterable[Conflict]:
    aircraft = flight.aircraft
    if aircraft is None:
        return
    if aircraft.status == AircraftStatus.AOG:
        yield Conflict(
            kind="aircraft_aog",
            message=_("Борт %(registration)s в состоянии AOG")
            % {"registration": aircraft.registration},
        )
    elif aircraft.status == AircraftStatus.MAINTENANCE:
        yield Conflict(
            kind="aircraft_maintenance",
            message=_("Борт %(registration)s на техобслуживании")
            % {"registration": aircraft.registration},
        )


def _overlaps(flight: Flight) -> Iterable[Conflict]:
    """Пересечение по времени с другим рейсом того же борта."""
    others = (
        Flight.objects.filter(aircraft_id=flight.aircraft_id)
        .exclude(pk=flight.pk)
        .exclude(status__in=CLOSED_STATUSES)
        .filter(std_utc__lt=flight.sta_utc, sta_utc__gt=flight.std_utc)
    )
    for other in others:
        yield Conflict(
            kind="overlap",
            message=_("Пересечение с рейсом %(number)s на том же борту")
            % {"number": other.number},
            related_flight_id=other.pk,
        )


def _turnaround(flight: Flight) -> Iterable[Conflict]:
    """Между рейсами борта должен быть минимальный интервал.

    Величина берётся из типа воздушного судна: тяжёлому борту на разворот
    нужно больше времени, чем лёгкому, и единая константа здесь неверна.
    """
    aircraft = flight.aircraft
    if aircraft is None:
        return
    minimum = timedelta(minutes=aircraft.type.turnaround_min)

    neighbours = (
        Flight.objects.filter(aircraft_id=flight.aircraft_id)
        .exclude(pk=flight.pk)
        .exclude(status__in=CLOSED_STATUSES)
        .filter(
            Q(sta_utc__lte=flight.std_utc, sta_utc__gt=flight.std_utc - minimum)
            | Q(std_utc__gte=flight.sta_utc, std_utc__lt=flight.sta_utc + minimum)
        )
    )
    for other in neighbours:
        yield Conflict(
            kind="turnaround",
            message=_(
                "Между рейсами менее %(minutes)d минут, минимум для типа %(type)s"
            )
            % {"minutes": aircraft.type.turnaround_min, "type": aircraft.type.icao_type},
            related_flight_id=other.pk,
        )


def _expired_approvals(flight: Flight) -> Iterable[Conflict]:
    """Допуск проверяется на дату рейса, а не на сегодня (ADR-027).

    Рейс, запланированный после истечения допуска, должен подсвечиваться
    при планировании, а не за день до вылета.
    """
    aircraft = flight.aircraft
    if aircraft is None:
        return
    for approval in aircraft.approvals.all():
        if approval.valid_to < flight.std_utc:
            yield Conflict(
                kind="approval_expired",
                message=_("Допуск %(kind)s борта %(registration)s истекает %(date)s")
                % {
                    "kind": approval.kind,
                    "registration": aircraft.registration,
                    "date": f"{approval.valid_to:%d.%m.%Y}",
                },
            )
