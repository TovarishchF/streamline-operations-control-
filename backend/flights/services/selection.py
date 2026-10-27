"""Отбор суточного плана `[ТЗ 3.1.1]` (`SPEC.md § 4.2`).

Один отбор на список и на выгрузку: файл обязан совпадать с таблицей
на экране. Параметры — по `openapi.yaml` (`GET /flights`): период, борт,
тип ВС, клиент, статус, тип рейса, аэропорт, «есть неподтверждённые
услуги», «маржа ниже N %», сортировка.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING

from django.db.models import Exists, OuterRef, Q
from rest_framework.exceptions import ValidationError

from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from django.http import QueryDict

    from flights.models import Flight

# Неулаженные заявки: те же, что считает колонка «неподтверждённых»
# в строке плана.
UNSETTLED = (ServiceOrderStatus.DRAFT, ServiceOrderStatus.ORDERED, ServiceOrderStatus.REJECTED)

# Поле контракта → поле модели. Сортировка по произвольному имени из
# строки запроса — способ сортировать по чему угодно, включая чужое.
ORDERING = {
    "number": "number",
    "stdUtc": "std_utc",
    "staUtc": "sta_utc",
    "status": "status",
    "clientName": "client__name",
    "aircraftRegistration": "aircraft__registration",
    "depIcao": "dep_icao",
    "arrIcao": "arr_icao",
    "type": "type",
}


def _statuses(params: QueryDict) -> list[str]:
    """Статусы — и повтором параметра, как в контракте, и списком через запятую."""
    values: list[str] = []
    for raw in params.getlist("status"):
        values.extend(item for item in raw.split(",") if item)
    return values


def _param(params: QueryDict, name: str) -> str:
    return str(params.get(name, "") or "")


def apply(queryset: QuerySet[Flight], params: QueryDict) -> QuerySet[Flight]:
    statuses = _statuses(params)
    if statuses:
        queryset = queryset.filter(status__in=statuses)
    if _param(params, "clientId"):
        queryset = queryset.filter(client_id=_param(params, "clientId"))
    if _param(params, "aircraftId"):
        queryset = queryset.filter(aircraft_id=_param(params, "aircraftId"))
    if _param(params, "aircraftTypeId"):
        queryset = queryset.filter(aircraft__type_id=_param(params, "aircraftTypeId"))
    if _param(params, "from"):
        queryset = queryset.filter(std_utc__gte=_param(params, "from"))
    if _param(params, "to"):
        queryset = queryset.filter(std_utc__lte=_param(params, "to"))
    if _param(params, "airport"):
        icao = _param(params, "airport").upper()
        queryset = queryset.filter(Q(dep_icao=icao) | Q(arr_icao=icao))
    if _param(params, "type"):
        queryset = queryset.filter(type=_param(params, "type"))
    if _param(params, "hasUnconfirmedServices") in ("true", "false"):
        unsettled = Exists(
            ServiceOrder.objects.filter(flight=OuterRef("pk"), status__in=UNSETTLED)
        )
        queryset = queryset.filter(
            unsettled if _param(params, "hasUnconfirmedServices") == "true" else ~unsettled
        )
    if _param(params, "search"):
        needle = _param(params, "search").strip()
        queryset = queryset.filter(
            Q(number__icontains=needle)
            | Q(dep_icao__istartswith=needle)
            | Q(arr_icao__istartswith=needle)
            | Q(client__name__icontains=needle)
            | Q(aircraft__registration__icontains=needle)
        )
    return queryset.order_by(*_ordering(_param(params, "ordering")))


def _ordering(raw: str) -> tuple[str, ...]:
    descending = raw.startswith("-")
    field = ORDERING.get(raw.lstrip("-"))
    if field is None:
        return ("std_utc", "number")
    return (f"-{field}" if descending else field, "number")


def margin_threshold(params: QueryDict) -> Decimal | None:
    raw = _param(params, "marginBelowPercent")
    if not raw:
        return None
    try:
        value = Decimal(raw)
    except InvalidOperation:
        raise ValidationError({"marginBelowPercent": "Ожидается число процентов"}) from None
    if not value.is_finite():
        raise ValidationError({"marginBelowPercent": "Ожидается число процентов"})
    return value


def below_margin(queryset: QuerySet[Flight], threshold: Decimal) -> QuerySet[Flight]:
    """Рейсы с маржой (`mixed`) ниже порога.

    Маржа вычисляется, а не хранится, поэтому отбор идёт по рассчитанным
    значениям — тем же, что показывает колонка. Рейс, маржу которого
    не посчитать, в отбор не попадает: «ниже порога» про него не известно.
    """
    from billing.services import margin

    candidates = list(queryset)
    percents = margin.percents_for(candidates)
    keep = [
        flight.pk
        for flight in candidates
        if percents.get(flight.pk) is not None and Decimal(str(percents[flight.pk])) < threshold
    ]
    return queryset.filter(pk__in=keep)
