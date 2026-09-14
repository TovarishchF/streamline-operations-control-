"""Планирование рейса `[ТЗ 3.1.1]` (`DOMAIN.md § 7.8`).

Расчётные величины считаются здесь, а не в модели и не в интерфейсе
(`CLAUDE.md § 3` п. 10, п. 16). Курс фиксируется снимком на дату рейса
(п. 5): изменение справочника курсов не переписывает историю.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from billing.services import fx
from catalog.models import Airport
from core import clock, geo
from core.exceptions import DomainError
from flights.models import Flight, FlightRequest, FlightRequestStatus
from flights.services import conflicts as conflict_detector

if TYPE_CHECKING:
    from accounts.models import User
    from counterparties.models import Client
    from fleet.models import Aircraft

# Крейсерская скорость и расход по умолчанию, когда борт ещё не назначен.
# Средний бизнес-джет: оценка нужна уже на этапе планирования, а точная
# появится при назначении борта.
DEFAULT_CRUISE_KTS = 450
DEFAULT_BURN_KG_H = 600


class AirportNotFound(DomainError):
    """Аэропорта нет в справочнике."""

    code = "VALIDATION_ERROR"


class RequestAlreadyReviewed(DomainError):
    """Заявка уже рассмотрена либо не хватает причины отклонения."""

    code = "VALIDATION_ERROR"


def compute_route(dep_icao: str, arr_icao: str, aircraft: Aircraft | None) -> dict[str, int]:
    """Расстояние, блок-тайм и плановое топливо."""
    airports = {
        item.icao: item for item in Airport.objects.filter(icao__in=[dep_icao, arr_icao])
    }
    departure = airports.get(dep_icao)
    arrival = airports.get(arr_icao)
    missing = [code for code in (dep_icao, arr_icao) if code not in airports]
    if missing:
        raise AirportNotFound(
            f"Аэропорта нет в справочнике: {', '.join(missing)}",
            {"icao": missing},
        )
    assert departure is not None and arrival is not None

    cruise = aircraft.type.cruise_speed_kts if aircraft else DEFAULT_CRUISE_KTS
    burn = aircraft.type.fuel_burn_kg_per_hour if aircraft else DEFAULT_BURN_KG_H

    distance = geo.distance_nm(departure.lat, departure.lon, arrival.lat, arrival.lon)
    block_time = geo.block_time_min(distance, cruise)
    return {
        "distance_nm": round(distance),
        "block_time_min": block_time,
        "fuel_plan_kg": geo.fuel_plan_kg(block_time, burn),
    }


def next_flight_number() -> str:
    """Номер рейса вида SLG-1042.

    Номер сквозной и не переиспользуется: отменённый рейс сохраняет свой,
    иначе в переписке с поставщиком один номер означал бы два разных рейса.
    """
    last = Flight.objects.order_by("-number").values_list("number", flat=True).first()
    if not last or not last.startswith("SLG-"):
        return "SLG-1001"
    try:
        return f"SLG-{int(last.split('-')[1]) + 1}"
    except (IndexError, ValueError):
        return "SLG-1001"


@transaction.atomic
def create_flight(
    *,
    client: Client,
    dep_icao: str,
    arr_icao: str,
    std_utc: datetime,
    aircraft: Aircraft | None = None,
    flight_type: str = "charter",
    pax_count: int = 0,
    remarks: str = "",
    actor: User | None = None,
    template_id: str | None = None,
    is_demo: bool = False,
    source: AuditSource = AuditSource.USER,
) -> Flight:
    """Создаёт рейс с рассчитанным маршрутом и снимком курсов."""
    route = compute_route(dep_icao, arr_icao, aircraft)

    flight = Flight.objects.create(
        organization=client.organization,
        number=next_flight_number(),
        client=client,
        aircraft=aircraft,
        type=flight_type,
        dep_icao=dep_icao,
        arr_icao=arr_icao,
        std_utc=std_utc,
        sta_utc=std_utc + timedelta(minutes=route["block_time_min"]),
        pax_count=pax_count,
        billing_currency=client.settlement_currency,
        fx_snapshot=fx.snapshot(std_utc.date()),
        remarks=remarks,
        template_id=template_id,
        is_demo=is_demo,
        **route,
    )

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(
            flight, fields=["number", "client_id", "dep_icao", "arr_icao", "std_utc", "status"]
        ),
        source=source,
        is_demo=is_demo,
    )
    record_conflicts(flight, actor=actor, source=source)
    return flight


def record_conflicts(
    flight: Flight, *, actor: User | None = None, source: AuditSource = AuditSource.USER
) -> list[conflict_detector.Conflict]:
    """Записывает обнаруженные конфликты в журнал.

    Конфликт не запрещает сохранение, но он должен быть зафиксирован
    с причиной: спустя неделю «почему рейс поставили на борт в AOG»
    выясняется по журналу, а не по памяти диспетчера.
    """
    found = conflict_detector.detect(flight)
    if not found:
        return []

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="schedule_conflict",
        actor=actor,
        after={"conflicts": [{"kind": item.kind, "reason": item.message} for item in found]},
        comment="; ".join(item.message for item in found),
        source=source,
        is_demo=flight.is_demo,
    )
    return found


@transaction.atomic
def update_route(flight: Flight, *, actor: User | None = None, **changes: Any) -> Flight:
    """Изменяет параметры рейса и пересчитывает маршрут.

    Пересчёт обязателен: смена аэропорта или борта меняет расстояние,
    время в пути и заправку, а рассинхронизованные расчётные поля хуже,
    чем их отсутствие.
    """
    before = audit.snapshot(
        flight,
        fields=["dep_icao", "arr_icao", "std_utc", "aircraft_id", "pax_count", "remarks"],
    )

    for field, value in changes.items():
        setattr(flight, field, value)

    route = compute_route(flight.dep_icao, flight.arr_icao, flight.aircraft)
    for field, value in route.items():
        setattr(flight, field, value)
    flight.sta_utc = flight.std_utc + timedelta(minutes=route["block_time_min"])

    flight.save()

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="updated",
        actor=actor,
        before=before,
        after=audit.snapshot(
            flight,
            fields=["dep_icao", "arr_icao", "std_utc", "aircraft_id", "pax_count", "remarks"],
        ),
        is_demo=flight.is_demo,
    )
    record_conflicts(flight, actor=actor)
    return flight


@transaction.atomic
def approve_request(request: FlightRequest, *, actor: User | None = None) -> Flight:
    """Подтверждает заявку клиента и создаёт рейс `[ТЗ 3.5.3]`.

    Клиент не создаёт рейс сам: заявка попадает диспетчеру в очередь,
    и только после подтверждения появляется рейс (`SPEC § 2.2`, сноска).
    """
    if request.status != FlightRequestStatus.PENDING:
        raise RequestAlreadyReviewed(
            f"Заявка уже рассмотрена: {request.get_status_display()}",
            {"status": request.status},
        )

    flight = create_flight(
        client=request.client,
        dep_icao=request.dep_icao,
        arr_icao=request.arr_icao,
        std_utc=request.requested_std_utc,
        pax_count=request.pax_count,
        remarks=request.comment,
        actor=actor,
        is_demo=request.is_demo,
    )

    request.status = FlightRequestStatus.APPROVED
    request.flight = flight
    request.save(update_fields=["status", "flight", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="request_approved",
        actor=actor,
        after={"requestId": request.pk, "number": flight.number},
        is_demo=request.is_demo,
    )
    return flight


@transaction.atomic
def reject_request(
    request: FlightRequest, reason: str, *, actor: User | None = None
) -> FlightRequest:
    """Отклоняет заявку. Причина обязательна: клиенту нужно объяснение."""
    if request.status != FlightRequestStatus.PENDING:
        raise RequestAlreadyReviewed(
            f"Заявка уже рассмотрена: {request.get_status_display()}",
            {"status": request.status},
        )
    if not reason:
        raise RequestAlreadyReviewed(
            "Не указана причина отклонения: клиенту нужно объяснение",
            {"field": "reason"},
        )

    request.status = FlightRequestStatus.REJECTED
    request.rejection_reason = reason
    request.save(update_fields=["status", "rejection_reason", "updated_at", "version"])
    return request


def local_time_at(icao: str, moment: datetime) -> datetime:
    """Момент в местном времени аэропорта.

    Подпись зоны обязательна всегда (`CLAUDE.md § 3` п. 2), поэтому
    возвращается осведомлённое о зоне значение, а не «голая» дата.
    """
    from zoneinfo import ZoneInfo

    airport = Airport.objects.filter(icao=icao).only("timezone").first()
    zone = ZoneInfo(airport.timezone) if airport else ZoneInfo("UTC")
    return moment.astimezone(zone)


def now_utc() -> datetime:
    return clock.now()
