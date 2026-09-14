"""Генерация серии рейсов из шаблона `[ТЗ 3.1.1]`.

Время вылета в шаблоне задано **местным** временем аэропорта вылета:
диспетчер договаривается о слоте в местном времени, а не в UTC. Перевод
делается здесь, на каждую дату отдельно.

Это не формальность. В зоне с переходом на летнее время одно и то же
местное время в марте и в апреле даёт разное UTC. Если посчитать смещение
один раз и применить ко всей серии, половина рейсов уедет на час — и уедет
незаметно, потому что в интерфейсе будет показано ровно то время, которое
диспетчер вводил.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from django.db import transaction

from audit.models import AuditSource
from catalog.models import Airport
from core.exceptions import DomainError
from flights.models import Flight, FlightTemplate
from flights.services import planning

if TYPE_CHECKING:
    from accounts.models import User

# Предел на один вызов: серия на год — почти всегда опечатка в датах,
# а полторы тысячи рейсов молча создавать нельзя.
MAX_SERIES_DAYS = 366


class SeriesTooLong(DomainError):
    code = "VALIDATION_ERROR"


def occurrences(template: FlightTemplate, since: date, until: date) -> list[datetime]:
    """Моменты вылета серии в UTC.

    Возвращается именно UTC: местное время нужно только для того, чтобы
    его получить, и дальше по системе не ходит (`CLAUDE.md § 3` п. 2).
    """
    if (until - since).days > MAX_SERIES_DAYS:
        raise SeriesTooLong(
            f"Период больше {MAX_SERIES_DAYS} дней: проверьте даты",
            {"days": (until - since).days},
        )

    airport = Airport.objects.filter(icao=template.dep_icao).only("timezone").first()
    if airport is None:
        raise planning.AirportNotFound(
            f"Аэропорта нет в справочнике: {template.dep_icao}",
            {"icao": [template.dep_icao]},
        )
    zone = ZoneInfo(airport.timezone)

    weekdays = {int(day) for day in template.weekdays}
    moments: list[datetime] = []

    current = since
    while current <= until:
        if current.isoweekday() in weekdays:
            # Смещение берётся для конкретной даты: в зоне с переходом
            # на летнее время оно у соседних дат разное.
            local = datetime.combine(current, template.dep_time_local, tzinfo=zone)
            moments.append(local.astimezone(ZoneInfo("UTC")))
        current += timedelta(days=1)
    return moments


@transaction.atomic
def generate(
    template: FlightTemplate,
    since: date,
    until: date,
    *,
    actor: User | None = None,
    is_demo: bool = False,
    source: AuditSource = AuditSource.USER,
) -> list[Flight]:
    """Создаёт рейсы серии. Уже существующие пропускает.

    Повторный запуск за тот же период не плодит дубли: диспетчер продлевает
    серию, задавая период с запасом, и это нормальный сценарий, а не ошибка.
    """
    existing = set(
        Flight.objects.filter(template=template).values_list("std_utc", flat=True)
    )

    created: list[Flight] = []
    for moment in occurrences(template, since, until):
        if moment in existing:
            continue
        created.append(
            planning.create_flight(
                client=template.client,
                dep_icao=template.dep_icao,
                arr_icao=template.arr_icao,
                std_utc=moment,
                template_id=template.pk,
                actor=actor,
                is_demo=is_demo,
                source=source,
            )
        )
    return created
