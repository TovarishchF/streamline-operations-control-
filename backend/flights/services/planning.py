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
from core.exceptions import DomainError, ScheduleConflict
from flights.models import Flight, FlightRequest, FlightRequestStatus, FlightTemplate
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
    is_generated: bool = False,
    source: AuditSource = AuditSource.USER,
) -> Flight:
    """Создаёт рейс с рассчитанным маршрутом и снимком курсов."""
    # Рейс клиента из набора генератора — тоже запись набора (ADR-016):
    # иначе он держал бы клиента связью PROTECT, и очистка набора падала.
    is_generated = is_generated or client.is_generated
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
        is_generated=is_generated,
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
        is_generated=is_generated,
    )
    record_conflicts(flight, actor=actor, source=source)
    return flight


def record_conflicts(
    flight: Flight,
    *,
    actor: User | None = None,
    source: AuditSource = AuditSource.USER,
    reason: str = "",
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
        comment="; ".join(item.message for item in found)
        + (f". Подтверждено: {reason}" if reason.strip() else ""),
        source=source,
        is_generated=flight.is_generated,
    )
    return found


# Поля, изменение которых двигает рейс в расписании: по ним проверяются
# новые конфликты и уходят письма клиенту и поставщикам `[ТЗ 3.1.3]`.
SCHEDULE_FIELDS = ("std_utc", "sta_utc", "aircraft_id", "dep_icao", "arr_icao")
ROUTE_FIELDS = ("aircraft_id", "dep_icao", "arr_icao")
AUDITED_FIELDS = (*SCHEDULE_FIELDS, "pax_count", "remarks")


class ScheduleChangeInvalid(DomainError):
    """Прилёт раньше вылета и прочие невозможные правки расписания."""

    code = "VALIDATION_ERROR"


def _conflict_keys(found: list[conflict_detector.Conflict]) -> set[tuple[str, str | None]]:
    return {(item.kind, item.related_flight_id) for item in found}


@transaction.atomic
def update_route(
    flight: Flight,
    *,
    actor: User | None = None,
    override_reason: str = "",
    **changes: Any,
) -> Flight:
    """Изменяет параметры рейса `[ТЗ 3.1.3]` (`SPEC.md § 4.1`).

    Сценарий один для формы и для перетаскивания на планшете: проверка
    конфликтов → подтверждение с причиной → аудит → письма в исходящие.

    * Смена маршрута или борта пересчитывает расстояние, время в пути
      и заправку. Сдвиг по времени сохраняет длительность рейса: полоса,
      перенесённая на планшете, не меняет своей ширины. Явный `sta_utc` —
      растягивание полосы — задаёт длительность.
    * Конфликт не запрещает сохранение, но новый конфликт, появившийся
      от этой правки, требует причины (`override_reason`); без неё —
      отказ со списком конфликтов. Причина идёт в аудит.
    """
    before = audit.snapshot(
        flight,
        fields=list(AUDITED_FIELDS),
    )
    previous_std, previous_sta = flight.std_utc, flight.sta_utc
    conflicts_before = _conflict_keys(conflict_detector.detect(flight))
    duration = flight.sta_utc - flight.std_utc

    explicit_sta = changes.pop("sta_utc", None)
    for field, value in changes.items():
        setattr(flight, field, value)

    # Сравнение по снимку, а не по ключам правки: борт назначают и полем
    # `aircraft_id`, и объектом `aircraft`.
    current_route = audit.snapshot(flight, fields=list(ROUTE_FIELDS))
    route_changed = any(before.get(field) != current_route[field] for field in ROUTE_FIELDS)
    route = compute_route(flight.dep_icao, flight.arr_icao, flight.aircraft)
    for field, value in route.items():
        setattr(flight, field, value)

    if explicit_sta is not None:
        flight.sta_utc = explicit_sta
    elif route_changed:
        flight.sta_utc = flight.std_utc + timedelta(minutes=route["block_time_min"])
    else:
        flight.sta_utc = flight.std_utc + duration
    if flight.sta_utc <= flight.std_utc:
        raise ScheduleChangeInvalid(
            "Прилёт должен быть позже вылета", {"stdUtc": flight.std_utc.isoformat()}
        )

    after = audit.snapshot(
        flight,
        fields=list(AUDITED_FIELDS),
    )
    schedule_changed = any(before.get(field) != after.get(field) for field in SCHEDULE_FIELDS)

    found = conflict_detector.detect(flight) if schedule_changed else []
    introduced = [
        item for item in found if (item.kind, item.related_flight_id) not in conflicts_before
    ]
    if introduced and not override_reason.strip():
        raise ScheduleConflict(
            "Изменение создаёт конфликт расписания. Подтвердите с указанием причины "
            "или выберите другое время или борт.",
            {
                "conflicts": [
                    {
                        "kind": item.kind,
                        "message": item.message,
                        "relatedFlightId": item.related_flight_id,
                    }
                    for item in introduced
                ]
            },
        )

    flight.save()

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="updated",
        actor=actor,
        before=before,
        after=after,
        comment=override_reason,
        is_generated=flight.is_generated,
    )
    if schedule_changed:
        record_conflicts(flight, actor=actor, reason=override_reason)
        _announce_schedule_change(
            flight, previous_std=previous_std, previous_sta=previous_sta, reason=override_reason
        )
        from billing.services import margin

        # Тариф выбирается на дату оказания: перенос рейса может сменить правило.
        margin.flight_changed(flight.pk)
    return flight


def _announce_schedule_change(
    flight: Flight, *, previous_std: datetime, previous_sta: datetime, reason: str
) -> None:
    """Последствия переноса `[ТЗ 3.1.3]`: сроки заявок и письма клиенту и поставщикам."""
    from comms.services import events as comms_events
    from orders.models import ServiceOrderStatus
    from orders.services import sla

    if flight.std_utc != previous_std:
        comms_events.flight_rescheduled(flight, previous_std=previous_std, reason=reason)

    active = flight.service_orders.exclude(
        status__in=(
            ServiceOrderStatus.COMPLETED,
            ServiceOrderStatus.CANCELLED,
            ServiceOrderStatus.REJECTED,
        )
    ).select_related("service", "vendor", "flight")
    for order in active:
        departure = order.leg == "departure"
        previous = previous_std if departure else previous_sta
        moment = flight.std_utc if departure else flight.sta_utc
        if previous == moment:
            continue
        if sla.follow_flight(order, previous_moment=previous, moment=moment):
            order.save(
                update_fields=[
                    "sla_confirm_deadline", "sla_completion_deadline", "updated_at", "version",
                ]
            )
        # Черновик поставщику не отправлялся — и об изменении ему писать нечего.
        if order.vendor_id and order.status != ServiceOrderStatus.DRAFT:
            comms_events.order_changed(order, previous_moment=previous, moment=moment)


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
        is_generated=request.is_generated,
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
        is_generated=request.is_generated,
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


@transaction.atomic
def create_template(*, data: dict[str, Any], actor: User) -> FlightTemplate:
    """Заводит шаблон регулярного рейса `[ТЗ 3.1.1]`.

    Организация берётся из учётной записи автора: шаблон принадлежит
    эксплуатанту, а не тому, кто его завёл.

    Услуги по умолчанию заводятся в той же транзакции: шаблон без них
    сгенерирует серию пустых рейсов, и диспетчер добавит услуги руками
    к каждому — ровно та работа, ради устранения которой шаблон и нужен.
    """
    from flights.models import TemplateService

    if actor.organization is None:
        # Учётная запись без организации — это ошибка заведения пользователя.
        # Молча подставить первую попавшуюся организацию значило бы завести
        # шаблон у чужого эксплуатанта.
        raise DomainError(
            "У учётной записи нет организации: шаблон принадлежит эксплуатанту"
        )

    template = FlightTemplate.objects.create(
        organization=actor.organization,
        name=data["name"],
        client_id=data["clientId"],
        aircraft_type_id=data["aircraftTypeId"],
        dep_icao=str(data["depIcao"]).upper(),
        arr_icao=str(data["arrIcao"]).upper(),
        dep_time_local=data["depTimeLocal"],
        weekdays=data["weekdays"],
    )

    for item in data.get("defaultServices") or []:
        TemplateService.objects.create(
            template=template,
            service_id=item["service_id"],
            leg=item["leg"],
            attributes=item.get("attributes") or {},
        )

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=template.pk,
        action="template_created",
        actor=actor,
        after=audit.snapshot(template),
        is_generated=template.is_generated,
    )
    return template


class FlightRequestInvalid(DomainError):
    """Заявка клиента на рейс противоречит сама себе или чужому шаблону."""

    code = "VALIDATION_ERROR"


@transaction.atomic
def submit_request(
    *,
    client: Client,
    dep_icao: str,
    arr_icao: str,
    requested_std_utc: datetime,
    pax_count: int,
    comment: str,
    template: FlightTemplate | None,
    actor: User,
) -> FlightRequest:
    """Заявка клиента на рейс из портала `[ТЗ 3.5.3]`.

    Рейсом она становится только после подтверждения диспетчером
    (`SPEC § 2.2`, сноска). Заявка клиента из набора генератора —
    тоже запись набора (ADR-038): иначе очистка набора наткнулась бы
    на ссылку введённого на сгенерированное.
    """
    dep, arr = dep_icao.upper(), arr_icao.upper()
    if dep == arr:
        raise FlightRequestInvalid("Аэропорты вылета и прилёта совпадают")
    known = set(Airport.objects.filter(icao__in=[dep, arr]).values_list("icao", flat=True))
    missing = [code for code in (dep, arr) if code not in known]
    if missing:
        raise AirportNotFound(
            f"Аэропорта нет в справочнике: {', '.join(missing)}", {"icao": missing}
        )
    if requested_std_utc <= clock.now():
        raise FlightRequestInvalid("Время вылета в заявке уже прошло")
    if template is not None and template.client_id != client.pk:
        raise FlightRequestInvalid("Шаблон принадлежит другому клиенту")

    request = FlightRequest.objects.create(
        organization=client.organization,
        client=client,
        dep_icao=dep,
        arr_icao=arr,
        requested_std_utc=requested_std_utc,
        pax_count=pax_count,
        comment=comment,
        is_generated=client.is_generated,
    )
    audit.record(
        entity_type=AuditEntityType.CLIENT,
        entity_id=client.pk,
        action="flight_request_submitted",
        actor=actor,
        after=audit.snapshot(request),
        comment=f"По шаблону {template.name}" if template is not None else "",
        is_generated=request.is_generated,
    )
    return request
