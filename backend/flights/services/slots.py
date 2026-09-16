"""Слоты в координируемых аэропортах `[ТЗ 3.1.1, 3.2.1, 4.2]` (ADR-026).

Публичного интерфейса слот-координации не существует (`INTEGRATIONS § 5.1`):
координаторы работают сообщениями формата IATA SSIM по электронной почте
и через собственные веб-кабинеты. Здесь — **инструмент подготовки
переписки**, а не подключение, и называть это подключением нельзя.

Что делает модуль:

* собирает черновик сообщения SCR по реестру;
* разбирает ответ координатора и **предлагает** результат;
* применяет предложение, когда его подтвердил человек.

Про формат. Образцы переписки у заказчика ещё не запрошены (`G-34`,
`INTEGRATIONS § 5.1`), поэтому порядок полей собран по структуре SSIM
из открытых источников и проверен не на настоящих сообщениях координатора.
Поэтому сообщение — черновик: оно показывается диспетчеру, правится
и отправляется им, а не уходит само. Когда образцы придут, сверять нужно
именно этот модуль.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType
from core import clock
from core.exceptions import DomainError
from flights.models import Slot, SlotStatus, SlotType

if TYPE_CHECKING:
    from accounts.models import User
    from flights.models import Flight

# Месяцы в трёхбуквенном виде SSIM. Латиницей и только заглавными:
# это код формата, а не текст для человека, и переводу он не подлежит.
MONTHS = (
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
)

# Тип движения в SSIM: прилёт `A`, вылет `D`.
MOVEMENT: dict[str, str] = {SlotType.ARRIVAL: "A", SlotType.DEPARTURE: "D"}

# Признак подтверждения и отказа в ответе координатора.
CONFIRM_WORDS = ("confirm", "accepted", "approved", "подтвер", "согласован")
REJECT_WORDS = ("reject", "denied", "unable", "declin", "отказ", "отклон")

# Время в ответе: `1230`, `12:30`, `1230Z`.
ANSWER_TIME = re.compile(r"\b([01]\d|2[0-3]):?([0-5]\d)Z?\b")


class SlotAnswerUnclear(DomainError):
    """Ответ координатора не разобран: нужно решение человека."""

    code = "VALIDATION_ERROR"


class SlotAlreadyAnswered(DomainError):
    """Слот уже получил ответ координатора."""

    code = "SLOT_ALREADY_ANSWERED"
    http_status = 409


class SlotAlreadyRequested(DomainError):
    """На эту связку рейс-аэропорт-движение слот уже запрошен."""

    code = "VALIDATION_ERROR"


@dataclass(frozen=True, slots=True)
class Answer:
    """Что разбор вычитал из ответа координатора.

    `status` пуст, если разбор не понял ответ. Это не сбой: свободный текст
    координатора не обязан укладываться в правила, и решение тогда
    принимает диспетчер.
    """

    status: str
    confirmed_utc: datetime | None
    note: str


def season_code(moment: date) -> str:
    """Код сезона IATA: `S`/`W` и две цифры года.

    Летний сезон начинается в последнее воскресенье марта, зимний —
    в последнее воскресенье октября. Даты считаются, а не берутся
    таблицей: таблица устаревает каждый год.
    """
    summer_start = _last_sunday(moment.year, 3)
    winter_start = _last_sunday(moment.year, 10)

    if moment < summer_start:
        # Январь и февраль относятся к зимнему сезону прошлого года.
        return f"W{(moment.year - 1) % 100:02d}"
    if moment < winter_start:
        return f"S{moment.year % 100:02d}"
    return f"W{moment.year % 100:02d}"


DECEMBER = 12


def _last_sunday(year: int, month: int) -> date:
    following = date(year + (month == DECEMBER), month % DECEMBER + 1, 1)
    last_day = following - timedelta(days=1)
    return last_day - timedelta(days=(last_day.weekday() + 1) % 7)


def ssim_date(moment: datetime | date) -> str:
    """Дата в виде `15SEP`."""
    value = moment.date() if isinstance(moment, datetime) else moment
    return f"{value.day:02d}{MONTHS[value.month - 1]}"


def _iata_for(icao: str) -> str:
    """Код аэропорта для сообщения.

    SSIM оперирует трёхбуквенными кодами IATA. Если у площадки его нет,
    подставляется ИКАО — это заметно в тексте, и диспетчер поправит,
    а молчаливая пустота в сообщении координатору читалась бы как ошибка
    системы.
    """
    from catalog.models import Airport

    airport = Airport.objects.filter(icao=icao).first()
    return (airport.iata if airport and airport.iata else icao).upper()


def _counterpart_icao(slot: Slot) -> str:
    """Второй конец маршрута: откуда прилёт либо куда вылет."""
    flight = slot.flight
    return flight.dep_icao if slot.type == SlotType.ARRIVAL else flight.arr_icao


def build_scr(slot: Slot) -> str:
    """Черновик сообщения SCR по слоту.

    Возвращается текст, а не отправленное сообщение: получатель, тема
    и окончательная правка — за диспетчером.
    """
    flight: Flight = slot.flight
    moment = slot.requested_utc
    aircraft = flight.aircraft.type.icao_type if flight.aircraft else "ZZZZ"
    registration = flight.aircraft.registration if flight.aircraft else ""

    # Строка запроса: тип действия, рейс, период, дни недели, тип ВС,
    # число мест, второй аэропорт, время движения.
    day_of_week = moment.isoweekday()
    days = "".join(str(day_of_week) if index + 1 == day_of_week else "0" for index in range(7))

    request_line = " ".join(
        (
            "N",
            flight.number.replace("-", ""),
            f"{ssim_date(moment)}{ssim_date(moment)}",
            days,
            aircraft,
            f"{flight.pax_count:03d}",
            _iata_for(_counterpart_icao(slot)),
            f"{moment:%H%M}{MOVEMENT[slot.type]}",
        )
    )

    lines = [
        "SCR",
        season_code(moment.date()),
        ssim_date(clock.now()),
        _iata_for(slot.airport_icao),
        request_line,
        f"SI {slot.get_type_display().upper()} SLOT REQUEST"
        + (f" / {registration}" if registration else ""),
    ]
    if slot.message_number:
        lines.append(f"GI REF {slot.message_number}")

    return "\n".join(lines)


def next_message_number(at: datetime | None = None) -> str:
    """Номер сообщения вида `SCR-2026-0007`.

    Нумерация сквозная по году и без дыр: счётчик тот же, что у документов
    (`BACKEND.md § 3.5`). Номер нужен, чтобы связать ответ координатора
    с запросом — в переписке ссылаются именно на него.
    """
    from billing.services import numbering

    return numbering.next_number("slot", at=at)


@transaction.atomic
def prepare_scr(*, slot: Slot, actor: User) -> tuple[Slot, str]:
    """Присваивает слоту номер сообщения и собирает черновик."""
    if not slot.message_number:
        slot.message_number = next_message_number(slot.requested_utc)
        slot.save(update_fields=["message_number", "updated_at", "version"])
        audit.record(
            entity_type=AuditEntityType.FLIGHT,
            entity_id=slot.flight_id,
            action="slot_message_prepared",
            actor=actor,
            after={"slotId": slot.pk, "messageRef": slot.message_number},
            is_demo=slot.is_demo,
        )
    return slot, build_scr(slot)


def parse_answer(text: str, *, slot: Slot) -> Answer:
    """Разбирает ответ координатора.

    Разбор **предлагает**: подтверждение слота — основание выпускать рейс,
    и ошибиться здесь дороже, чем переспросить. Непонятый ответ возвращается
    с пустым состоянием, и решение принимает диспетчер.
    """
    lowered = text.lower()

    # Отказ проверяется первым: «unable to confirm» содержит оба признака.
    if any(word in lowered for word in REJECT_WORDS):
        return Answer(status=SlotStatus.REJECTED, confirmed_utc=None, note=_summary(text))

    if not any(word in lowered for word in CONFIRM_WORDS):
        return Answer(status="", confirmed_utc=None, note=_summary(text))

    return Answer(
        status=SlotStatus.CONFIRMED,
        confirmed_utc=_confirmed_time(text, slot),
        note=_summary(text),
    )


def _confirmed_time(text: str, slot: Slot) -> datetime | None:
    """Время из ответа, привязанное к дате запрошенного слота.

    Координатор называет время, а не дату: слот запрашивался на конкретные
    сутки. Если время не найдено — подтверждено запрошенное, и это надо
    показать диспетчеру, а не подставить молча.
    """
    match = ANSWER_TIME.search(text)
    if match is None:
        return None
    hours, minutes = int(match.group(1)), int(match.group(2))
    return datetime.combine(
        slot.requested_utc.date(), time(hours, minutes), tzinfo=UTC
    )


def _summary(text: str) -> str:
    """Короткая выдержка из ответа для карточки слота."""
    collapsed = " ".join(text.split())
    return collapsed[:500]


@transaction.atomic
def apply_answer(
    *,
    slot: Slot,
    actor: User,
    status: str = "",
    confirmed_utc: datetime | None = None,
    text: str = "",
) -> Slot:
    """Применяет ответ координатора `[ТЗ 3.1.1]`.

    Состояние и время можно задать прямо — так разбирается ответ, который
    система не поняла. Это и есть ручной разбор, а не обход проверки.
    """
    if slot.status in (SlotStatus.CONFIRMED, SlotStatus.REJECTED):
        raise SlotAlreadyAnswered(
            _("По слоту уже получен ответ координатора"), {"status": slot.status}
        )

    parsed = parse_answer(text, slot=slot) if text else Answer("", None, "")
    resolved = status or parsed.status
    if resolved not in (SlotStatus.CONFIRMED, SlotStatus.REJECTED):
        raise SlotAnswerUnclear(
            _("Ответ координатора не разобран: укажите решение и время"),
            {"note": parsed.note},
        )

    before = audit.snapshot(slot)
    slot.status = resolved
    if resolved == SlotStatus.CONFIRMED:
        # Время не найдено — подтверждено запрошенное. Это видно в карточке,
        # а не подставляется молча: диспетчер сверит с письмом.
        slot.confirmed_utc = confirmed_utc or parsed.confirmed_utc or slot.requested_utc
    else:
        slot.confirmed_utc = None
    if parsed.note:
        slot.comment = parsed.note
    slot.save()

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=slot.flight_id,
        action="slot_answer_applied",
        actor=actor,
        before=before,
        after=audit.snapshot(slot),
        comment=parsed.note,
        is_demo=slot.is_demo,
    )
    return slot


@transaction.atomic
def request_slot(
    *,
    flight: Flight,
    airport_icao: str,
    slot_type: str,
    requested_utc: datetime,
    actor: User,
) -> Slot:
    """Заводит запрос слота `[ТЗ 3.1.1]`.

    Один слот на связку рейс-аэропорт-движение: второй означал бы два места
    в расписании аэропорта на одно движение. Ограничение стоит и в базе,
    но объяснить отказ должен сервис — из нарушения ограничения человек
    не поймёт, что делать.
    """
    existing = Slot.objects.filter(
        flight=flight, airport_icao=airport_icao.upper(), type=slot_type
    ).first()
    if existing is not None:
        raise SlotAlreadyRequested(
            _("Слот на это движение уже запрошен"),
            {"slotId": existing.pk, "status": existing.status},
        )

    slot = Slot.objects.create(
        flight=flight,
        airport_icao=airport_icao.upper(),
        type=slot_type,
        requested_utc=requested_utc,
        status=SlotStatus.REQUESTED,
        is_demo=flight.is_demo,
    )
    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="slot_requested",
        actor=actor,
        after=audit.snapshot(slot),
        is_demo=slot.is_demo,
    )
    return slot
