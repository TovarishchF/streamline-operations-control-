"""Переходы автомата рейса `[ТЗ 3.1.1]` (`DOMAIN.md § 5.1`).

Единственный способ изменить статус рейса (`CLAUDE.md § 3` п. 3). Поле
`status` защищено `django-fsm-2`, присвоение в обход возбуждает исключение.

Определение автомата читается из `shared/state-machines/flight.json` —
того же файла, из которого строит машину веб-клиент (ADR-015). Переходы
не дублируются в коде: список из двух источников рано или поздно разъезжается.

Побочные эффекты перехода выполняются в той же транзакции, кроме исходящих
наружу вызовов: они уходят в Celery через `transaction.on_commit`
(`CLAUDE.md § 3` п. 13).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from core import clock
from core.exceptions import GuardNotSatisfied, TransitionNotAllowed
from flights import machine
from flights.models import Flight
from flights.services.guards import GUARDS

if TYPE_CHECKING:
    from accounts.models import User


def transition_by_name(name: str) -> dict[str, Any]:
    found = machine.transition_by_name(name)
    if found is None:
        raise TransitionNotAllowed(f"переход {name} в автомате рейса не объявлен")
    return found


def available_transitions(flight: Flight) -> list[str]:
    """Переходы, возможные из текущего состояния, без учёта условий.

    Недоступный переход показывается в интерфейсе неактивным, а не прячется:
    скрывать его — значит прятать причину (`SPEC § 4.4`).
    """
    return [item["name"] for item in machine.transitions() if flight.status in item["from"]]


# Условия, которые выполняет сам запрос перехода, а не состояние рейса:
# причину вводят в диалоге перехода. Карточка не показывает их
# невыполненными — иначе отмена была бы заблокирована всегда.
REQUEST_GUARDS = frozenset({"reason_provided"})


def check_guards(flight: Flight, name: str, *, skip: frozenset[str] = frozenset()) -> list[str]:
    """Невыполненные условия перехода. Пустой список — переход разрешён."""
    definition = transition_by_name(name)
    problems: list[str] = []
    for guard_name in definition.get("guards", []):
        if guard_name in skip:
            continue
        guard = GUARDS.get(guard_name)
        if guard is None:
            # Условие объявлено в автомате, но не реализовано: пропускать
            # такой переход молча нельзя — это дыра в проверке.
            problems.append(f"условие {guard_name} не реализовано на сервере")
            continue
        problem = guard(flight)
        if problem:
            problems.append(problem)
    return problems


def unmet_conditions(flight: Flight, name: str) -> list[str]:
    """Что мешает переходу из состояния рейса — для панели статуса."""
    return check_guards(flight, name, skip=REQUEST_GUARDS)


@transaction.atomic
def apply_transition(
    flight: Flight,
    name: str,
    *,
    actor: User | None = None,
    reason_code: str = "",
    comment: str = "",
    source: AuditSource | None = None,
    complete_without_invoice: bool = False,
) -> Flight:
    """Выполняет переход. Возбуждает исключение, если он невозможен."""
    definition = transition_by_name(name)

    if complete_without_invoice:
        if name != "complete":
            raise GuardNotSatisfied(
                "Отказ от счёта возможен только при завершении рейса",
                {"unsatisfied": ["Отказ от счёта относится к переходу «complete»"]},
            )
        # «Завершить без счёта» выбирается явно и с причиной (`DOMAIN.md § 5.1`).
        if not comment.strip():
            raise GuardNotSatisfied(
                "Завершение без счёта требует причины",
                {"unsatisfied": ["Не указана причина завершения без счёта"]},
            )
        flight.invoice_waived = True

    if flight.status not in definition["from"]:
        raise TransitionNotAllowed(
            f"переход «{name}» невозможен из состояния «{flight.get_status_display()}»",
            {"from": flight.status, "allowed": available_transitions(flight)},
        )

    if definition.get("requiresReason") and not reason_code:
        raise GuardNotSatisfied(
            "Переход требует указания причины",
            {"unsatisfied": ["Не указана причина"]},
        )

    # Причина проставляется до проверки условий: guard `reason_provided`
    # смотрит на поле, а не на аргумент.
    if reason_code:
        flight.status_reason_code = reason_code
        flight.status_reason_comment = comment

    problems = check_guards(flight, name)
    if problems:
        raise GuardNotSatisfied(
            "Условия перехода не выполнены",
            {"unsatisfied": problems},
        )

    before = audit.snapshot(flight, fields=["status", "atd_utc", "ata_utc"])
    previous_status = flight.status

    # Статус меняется вызовом перехода: поле защищено, и обычное присвоение
    # возбуждает исключение (`CLAUDE.md § 3` п. 3).
    getattr(flight, f"fsm_{name}")()

    changed = ["status"]
    for field in definition.get("sets", []):
        if getattr(flight, field, None) is None:
            setattr(flight, field, clock.now())
            changed.append(field)

    if reason_code:
        changed += ["status_reason_code", "status_reason_comment"]

    flight.save(update_fields=[*changed, "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.FLIGHT,
        entity_id=flight.pk,
        action="status_changed",
        actor=actor,
        before=before,
        after=audit.snapshot(flight, fields=["status", "atd_utc", "ata_utc"]),
        comment=(
            f"Без счёта: {comment}"
            if complete_without_invoice
            else comment or f"{previous_status} → {definition['to']}"
        ),
        source=source or (AuditSource.USER if actor else AuditSource.SYSTEM),
        is_generated=flight.is_generated,
    )

    _apply_effects(flight, name, definition, actor=actor, comment=comment, source=source)

    # Оповещение диспетчеров `[ТЗ 3.5.1]`. Автомат отвечает за состояние,
    # кому об этом сообщить — решают коммуникации.
    #
    # Переходы генератора не оповещают: он выстраивает историю стенда,
    # а не совершает события сейчас. Иначе колокольчик после `seed_sample`
    # содержал бы сотни записей о прошлом, и настоящее в нём потерялось бы
    # (`CLAUDE.md § 4`).
    if source != AuditSource.SEED:
        from comms.services import events as comms_events

        comms_events.flight_status_changed(flight, previous=previous_status, actor=actor)
    return flight


# Заявки, которые снимает отмена рейса. Из остальных состояний автомат
# заявки отмены не знает (`shared/state-machines/service-order.json`):
# оказанную услугу отменить нельзя.
CANCELLABLE_ORDER_STATUSES = ("draft", "ordered", "confirmed")


def _apply_effects(
    flight: Flight,
    name: str,
    definition: dict[str, Any],
    *,
    actor: User | None,
    comment: str,
    source: AuditSource | None,
) -> None:
    """Побочные эффекты перехода из определения автомата (`DOMAIN.md § 5.1`).

    Выполняются в той же транзакции; письма уходят после её фиксации
    (`CLAUDE.md § 3` п. 13). Эффект `mark_aircraft_aog` не выполняется:
    состояние борта — отдельный факт (ADR-009 п. 2), см. `GAPS.md` G-56.
    """
    effects = definition.get("effects", [])
    reason = comment or flight.status_reason_code

    if "cancel_all_orders" in effects:
        # Каждая заявка отменяется своим переходом: письмо поставщику
        # об отмене и запись аудита ставит автомат заявки, а не этот код.
        from orders.models import ServiceOrder
        from orders.services import transitions as order_transitions

        open_orders = (
            ServiceOrder.objects.filter(flight=flight, status__in=CANCELLABLE_ORDER_STATUSES)
            .select_related("flight", "service", "vendor")
            .order_by("pk")
        )
        for order in open_orders:
            order_transitions.apply_transition(
                order,
                "cancel",
                actor=actor,
                comment=f"Отмена рейса {flight.number}: {reason}",
                source=source,
            )

    if "notify_client" in effects and source != AuditSource.SEED:
        from comms.services import events as comms_events

        comms_events.flight_transitioned(flight, transition=name, reason=reason)

    if "recalculate_margin" in effects or "cancel_all_orders" in effects:
        from billing.services import margin

        margin.flight_changed(flight.pk)
