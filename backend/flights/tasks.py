"""Фоновые задачи рейсов `[ТЗ 3.1.2]` (`BACKEND.md § 5`).

Автопереходы по времени. Пока подключения к данным о движении ВС нет
(`INTEGRATIONS § 2.3`, TRACK в режиме `stub`), переход выполняется
по плановому времени — и это записывается в аудит как действие системы,
а не человека.

Задачи идемпотентны: повторный запуск ничего не ломает, потому что
переход из состояния, в котором рейс уже не находится, просто не найдёт
кандидатов.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import TYPE_CHECKING

from celery import shared_task
from django.db import transaction

from core import clock
from core.exceptions import DomainError
from flights.models import Flight, FlightStatus
from flights.services import transitions

if TYPE_CHECKING:
    from django.db.models import QuerySet

logger = logging.getLogger(__name__)

# Автопереход не должен «догонять» рейсы недельной давности: если рейс
# завис, это повод разобраться, а не молча его закрыть.
CATCH_UP_HOURS = 24


@shared_task(name="flights.auto_depart")  # type: ignore[misc]
def auto_depart() -> int:
    """Переводит в «В полёте» рейсы, у которых наступило плановое время."""
    now = clock.now()
    candidates = Flight.objects.filter(
        status=FlightStatus.READY_FOR_DEPARTURE,
        std_utc__lte=now,
        std_utc__gte=now - _catch_up(),
    )
    return _apply(candidates, "depart")


@shared_task(name="flights.auto_arrive")  # type: ignore[misc]
def auto_arrive() -> int:
    """Переводит в «Прилетел» рейсы, у которых наступило время прилёта.

    Прилёт и закрытие рейса — разные события (ADR-009): автоматически
    ставится только прилёт, закрывает рейс человек, оформив документы.
    """
    now = clock.now()
    candidates = Flight.objects.filter(
        status=FlightStatus.IN_FLIGHT,
        sta_utc__lte=now,
        sta_utc__gte=now - _catch_up(),
    )
    return _apply(candidates, "arrive")


def _catch_up() -> timedelta:
    return timedelta(hours=CATCH_UP_HOURS)


def _apply(candidates: QuerySet[Flight], name: str) -> int:
    moved = 0
    for flight in candidates:
        try:
            with transaction.atomic():
                transitions.apply_transition(flight, name)
            moved += 1
        except DomainError as error:
            # Один заблокированный рейс не должен останавливать остальные:
            # причина попадёт в журнал, а расписание поедет дальше.
            logger.warning(
                "автопереход не выполнен",
                extra={"flight": flight.number, "transition": name, "reason": str(error)},
            )
    return moved
