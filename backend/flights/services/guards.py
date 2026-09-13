"""Условия переходов автомата рейса `[ТЗ 3.1.1]` (`DOMAIN.md § 5.1`).

Каждое условие — отдельная функция с именем, совпадающим с именем guard
в `shared/state-machines/flight.json`. Совпадение проверяется тестом:
условие, объявленное в автомате и не реализованное на сервере, иначе
молча пропускало бы переход.

Функция возвращает причину отказа либо `None`. Не булево значение: при
отказе пользователю показывается список невыполненных условий, а «False»
в списке ничего не объясняет.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.utils.translation import gettext as _

from catalog.models import Airport, ServiceCategory
from fleet.models import AircraftStatus
from flights.models import SlotStatus
from orders.models import ServiceOrderStatus

if TYPE_CHECKING:
    from flights.models import Flight

# Заявки, которые считаются улаженными для перехода «Готов к вылету».
SETTLED_STATUSES = (ServiceOrderStatus.CONFIRMED, ServiceOrderStatus.COMPLETED)


def aircraft_assigned(flight: Flight) -> str | None:
    if flight.aircraft_id is None:
        return _("Не назначен борт")
    return None


def has_at_least_one_service_order(flight: Flight) -> str | None:
    if not flight.service_orders.exists():
        return _("Не создано ни одной заявки на услугу")
    return None


def all_orders_confirmed_or_completed(flight: Flight) -> str | None:
    pending = flight.service_orders.exclude(
        status__in=[*SETTLED_STATUSES, ServiceOrderStatus.CANCELLED]
    )
    names = [order.service.code for order in pending.select_related("service")]
    if names:
        return _("Не подтверждены заявки: %(codes)s") % {"codes": ", ".join(sorted(names))}
    return None


def no_rejected_orders(flight: Flight) -> str | None:
    rejected = flight.service_orders.filter(status=ServiceOrderStatus.REJECTED)
    names = [order.service.code for order in rejected.select_related("service")]
    if names:
        return _("Отклонены заявки: %(codes)s") % {"codes": ", ".join(sorted(names))}
    return None


def permit_confirmed_if_international(flight: Flight) -> str | None:
    """Международный рейс без подтверждённого разрешения не выпускается."""
    if not flight.is_international:
        return None

    confirmed = flight.service_orders.filter(
        service__category=ServiceCategory.PERMITS, status__in=SETTLED_STATUSES
    ).exists()
    if not confirmed:
        return _("Международный рейс: нет подтверждённого разрешительного документа")
    return None


def slot_confirmed_if_coordinated(flight: Flight) -> str | None:
    """Слот нужен только в координируемом аэропорту (ADR-026).

    Перечень таких аэропортов заказчик ещё не передал (G-34), поэтому
    признак берётся из справочника и редактируется администратором.
    """
    coordinated = set(
        Airport.objects.filter(
            icao__in=[flight.dep_icao, flight.arr_icao], is_coordinated=True
        ).values_list("icao", flat=True)
    )
    if not coordinated:
        return None

    confirmed = set(
        flight.slots.filter(status=SlotStatus.CONFIRMED).values_list("airport_icao", flat=True)
    )
    missing = sorted(coordinated - confirmed)
    if missing:
        return _("Нет подтверждённого слота: %(airports)s") % {"airports": ", ".join(missing)}
    return None


def departure_time_reached_or_manual(flight: Flight) -> str | None:
    """Вылет ставится вручную диспетчером либо автоматически по времени.

    Условие всегда выполнимо: ручной вылет раньше планового — обычное дело,
    и запрещать его нельзя. Проверка времени живёт в автопереходе.
    """
    return None


def arrival_time_reached_or_manual(flight: Flight) -> str | None:
    return None


def all_orders_completed_or_cancelled(flight: Flight) -> str | None:
    open_orders = flight.service_orders.exclude(
        status__in=[ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED]
    )
    names = [order.service.code for order in open_orders.select_related("service")]
    if names:
        return _("Не закрыты заявки: %(codes)s") % {"codes": ", ".join(sorted(names))}
    return None


def invoice_issued_or_explicitly_waived(flight: Flight) -> str | None:
    """Счета появятся на M7.

    До тех пор условие не проверяется, и это записано здесь, а не забыто:
    молчаливо пропускающий guard отличается от нереализованного только тем,
    что про него помнят.
    """
    return None


def aircraft_serviceable(flight: Flight) -> str | None:
    """Возврат из AOG в работу возможен, только когда борт исправен.

    Состояние борта и состояние рейса — разные факты (ADR-009): рейс
    можно вернуть в работу лишь после того, как борт вышел из AOG,
    иначе система разрешила бы планировать полёт на неисправной машине.
    """
    aircraft = flight.aircraft
    if aircraft is None:
        return _("Не назначен борт")
    if aircraft.status != AircraftStatus.SERVICEABLE:
        return _("Борт %(registration)s не исправен: %(status)s") % {
            "registration": aircraft.registration,
            "status": aircraft.get_status_display(),
        }
    return None


def reason_provided(flight: Flight) -> str | None:
    if not flight.status_reason_code:
        return _("Не указана причина")
    return None


#: Имя guard в автомате → функция. Полнота проверяется тестом.
GUARDS = {
    "aircraft_assigned": aircraft_assigned,
    "has_at_least_one_service_order": has_at_least_one_service_order,
    "all_orders_confirmed_or_completed": all_orders_confirmed_or_completed,
    "no_rejected_orders": no_rejected_orders,
    "permit_confirmed_if_international": permit_confirmed_if_international,
    "slot_confirmed_if_coordinated": slot_confirmed_if_coordinated,
    "departure_time_reached_or_manual": departure_time_reached_or_manual,
    "arrival_time_reached_or_manual": arrival_time_reached_or_manual,
    "aircraft_serviceable": aircraft_serviceable,
    "all_orders_completed_or_cancelled": all_orders_completed_or_cancelled,
    "invoice_issued_or_explicitly_waived": invoice_issued_or_explicitly_waived,
    "reason_provided": reason_provided,
}
