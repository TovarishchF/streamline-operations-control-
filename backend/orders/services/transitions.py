"""Переходы автомата заявки на услугу `[ТЗ 3.2.3]` (`DOMAIN.md § 5.2`).

Единственный способ изменить статус заявки (`CLAUDE.md § 3` п. 3). Поле
защищено `django-fsm-2`, присвоение в обход возбуждает исключение.

Определение автомата читается из `shared/state-machines/service-order.json` —
того же файла, из которого строит машину веб-клиент (ADR-015).

Условия объявлены в автомате именами, а реализованы здесь функциями с теми
же именами. Совпадение проверяется тестом: условие, объявленное и не
реализованное, молча пропускало бы переход.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from core import clock
from core.exceptions import GuardNotSatisfied, TransitionNotAllowed
from core.models import AttachmentKind
from orders.models import ServiceOrder, machine_transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import User

# ─────────────────────────── Условия переходов ───────────────────────────
#
# Функция возвращает причину отказа либо `None`. Не булево значение: при
# отказе пользователю показывается список невыполненных условий, а «False»
# в списке ничего не объясняет.


def vendor_assigned(order: ServiceOrder) -> str | None:
    if order.vendor_id is None:
        return _("Не назначен поставщик")
    return None


def service_available_at_airport(order: ServiceOrder) -> str | None:
    """Проверено при создании заявки (`SPEC.md § 5.2` п. 1).

    Повторная проверка здесь не нужна: заявка не могла быть создана
    без действующей цены, а снимок цены уже в ней.
    """
    if order.purchase_unit_amount is None:
        return _("Не зафиксирована закупочная цена")
    return None


def vendor_contract_valid(order: ServiceOrder) -> str | None:
    if order.contract_id is None:
        return _("Не зафиксирован договор с поставщиком")
    return None


def vendor_price_valid(order: ServiceOrder) -> str | None:
    if order.purchase_cost_amount is None:
        return _("Не рассчитана закупочная стоимость")
    return None


def lead_time_met_or_overridden(order: ServiceOrder) -> str | None:
    """Нарушение лидтайма подтверждается причиной, а не запрещается.

    Проверка выполняется при создании заявки; здесь остаётся убедиться,
    что подтверждение было получено, если оно требовалось.
    """
    moment = order.flight.std_utc if order.leg == "departure" else order.flight.sta_utc
    hours_left = (moment - clock.now()).total_seconds() / 3600
    if hours_left < order.service.lead_time_h and not order.override_reason.strip():
        return _("Лидтайм нарушен и не подтверждён причиной")
    return None


def reason_provided(order: ServiceOrder) -> str | None:
    if not order.rejection_reason.strip():
        return _("Не указана причина")
    return None


def actual_time_provided(order: ServiceOrder) -> str | None:
    """Фактическое время идёт в биллинг `[ТЗ 3.2.3]`, а не плановое."""
    if order.actual_start_at is None or order.actual_end_at is None:
        return _("Не указано фактическое время начала и окончания")
    if order.actual_end_at < order.actual_start_at:
        return _("Фактическое окончание раньше начала")
    return None


def actual_quantity_provided(order: ServiceOrder) -> str | None:
    """ADR-020: для топлива план и факт расходятся на каждом рейсе."""
    if order.actual_quantity is None:
        return _("Не указано фактическое количество")
    return None


def act_uploaded_if_required(order: ServiceOrder) -> str | None:
    if not order.service.requires_act_to_complete:
        return None
    has_act = order.documents.filter(
        kind=AttachmentKind.ACT, uploaded_at__isnull=False
    ).exists()
    if not has_act:
        return _("Для этой услуги обязателен акт выполненных работ")
    return None


GUARDS: dict[str, Callable[[ServiceOrder], str | None]] = {
    "vendor_assigned": vendor_assigned,
    "service_available_at_airport": service_available_at_airport,
    "vendor_contract_valid": vendor_contract_valid,
    "vendor_price_valid": vendor_price_valid,
    "lead_time_met_or_overridden": lead_time_met_or_overridden,
    "reason_provided": reason_provided,
    "actual_time_provided": actual_time_provided,
    "actual_quantity_provided": actual_quantity_provided,
    "act_uploaded_if_required": act_uploaded_if_required,
}


# ─────────────────────────── Переходы ───────────────────────────


def transition_by_name(name: str) -> dict[str, Any]:
    for item in machine_transitions():
        if item["name"] == name:
            return dict(item)
    raise TransitionNotAllowed(f"переход {name} в автомате заявки не объявлен")


def available_transitions(order: ServiceOrder) -> list[str]:
    """Переходы, возможные из текущего состояния, без учёта условий.

    Недоступный переход показывается неактивным, а не прячется: скрывать
    его — значит прятать причину (`SPEC.md § 4.4`).
    """
    return [item["name"] for item in machine_transitions() if order.status in item["from"]]


def check_guards(order: ServiceOrder, name: str) -> list[str]:
    """Невыполненные условия перехода. Пустой список — переход разрешён."""
    definition = transition_by_name(name)
    problems: list[str] = []
    for guard_name in definition.get("guards", []):
        guard = GUARDS.get(guard_name)
        if guard is None:
            # Условие объявлено в автомате, но не реализовано: пропускать
            # такой переход молча нельзя — это дыра в проверке.
            problems.append(f"условие {guard_name} не реализовано на сервере")
            continue
        problem = guard(order)
        if problem:
            problems.append(problem)
    return problems


def apply_transition_method(order: ServiceOrder, name: str) -> None:
    """Вызывает метод перехода `fsm_<name>`.

    Методы объявлены динамически по файлу автомата (ADR-015), поэтому
    статически их не видно. Обращение по имени собрано в одном месте,
    чтобы пометка для проверки типов не расползалась по коду.
    """
    getattr(order, f"fsm_{name}")()


@transaction.atomic
def apply_transition(
    order: ServiceOrder,
    name: str,
    *,
    actor: User | None = None,
    comment: str = "",
    source: AuditSource | None = None,
) -> ServiceOrder:
    """Выполняет переход. Возбуждает исключение, если он невозможен."""
    definition = transition_by_name(name)

    if order.status not in definition["from"]:
        raise TransitionNotAllowed(
            f"переход «{name}» невозможен из состояния «{order.get_status_display()}»",
            {
                "currentStatus": order.status,
                "requestedTransition": name,
                "allowed": available_transitions(order),
            },
        )

    # Причина проставляется до проверки условий: guard `reason_provided`
    # смотрит на поле, а не на аргумент.
    if definition.get("requiresReason"):
        if not comment.strip():
            raise GuardNotSatisfied(
                _("Переход требует указания причины"),
                {
                    "currentStatus": order.status,
                    "requestedTransition": name,
                    "unmetConditions": [
                        {"code": "reason_provided", "message": _("Не указана причина")}
                    ],
                },
            )
        order.rejection_reason = comment

    problems = check_guards(order, name)
    if problems:
        raise GuardNotSatisfied(
            _("Условия перехода не выполнены"),
            {
                "currentStatus": order.status,
                "requestedTransition": name,
                "unmetConditions": [{"code": "guard", "message": text} for text in problems],
            },
        )

    before = audit.snapshot(order, fields=["status", "confirmed_at", "started_at", "completed_at"])
    previous_status = order.status

    apply_transition_method(order, name)

    changed = ["status"]
    now = clock.now()
    for field in definition.get("sets", []):
        # Проставляются только временные метки; снимки и дедлайн SLA
        # ставит сервисный слой заказа, у них своя логика.
        if field.endswith("_at") and getattr(order, field, None) is None:
            setattr(order, field, now)
            changed.append(field)

    if name == "confirm" and order.sla_confirm_deadline is not None:
        # Нарушение SLA фиксируется в момент подтверждения, а не вычисляется
        # на лету: дедлайн и факт подтверждения — разные величины, и после
        # сдвига модельного времени вычисление задним числом соврёт.
        order.sla_breached = now > order.sla_confirm_deadline
        changed.append("sla_breached")

    if definition.get("requiresReason"):
        changed.append("rejection_reason")

    order.save(update_fields=[*changed, "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.SERVICE_ORDER,
        entity_id=order.pk,
        action="status_changed",
        actor=actor,
        before=before,
        after=audit.snapshot(
            order, fields=["status", "confirmed_at", "started_at", "completed_at"]
        ),
        comment=comment or f"{previous_status} → {definition['to']}",
        source=source or (AuditSource.USER if actor else AuditSource.SYSTEM),
        is_demo=order.is_demo,
    )
    return order
