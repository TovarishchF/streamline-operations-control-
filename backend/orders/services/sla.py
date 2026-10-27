"""Сроки SLA заявки `[ТЗ 3.2.3]` (`DOMAIN.md § 7.6`).

```
slaConfirmDeadline    = orderedAt + slaConfirmMin(категория, поставщик)
slaCompletionDeadline = плановое время услуги + slaCompletionMin
breach                = фактическое время > дедлайна
```

Сроки берутся из справочника правил (`orders.SlaRule`) в момент заказа
и фиксируются в заявке: правка справочника не переписывает сроки уже
оформленных заявок (`CLAUDE.md § 3` п. 5).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from django.db import transaction
from django.db.models import Q

from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from core import clock
from orders.models import ServiceOrder, ServiceOrderStatus, SlaPenaltyKind, SlaRule

if TYPE_CHECKING:
    from datetime import datetime

    from accounts.models import User

logger = logging.getLogger(__name__)

# Последний рубеж, если в справочнике нет даже правила по умолчанию:
# правила не удаляются, но база может оказаться пустой до миграции
# с начальными значениями (G-39).
FALLBACK_CONFIRM_MINUTES = 240


@dataclass(frozen=True, slots=True)
class SlaTerms:
    """Сроки, применимые к заявке, и правило, из которого они взяты."""

    confirm_minutes: int
    completion_minutes: int | None
    rule: SlaRule | None


def rule_for(*, category: str, vendor_id: str | None) -> SlaRule | None:
    """Самое специфичное действующее правило для категории и поставщика.

    На каждую область действует одно правило (ограничение в базе),
    поэтому специфичность у кандидатов не совпадает никогда.
    """
    vendor_scope = Q(vendor__isnull=True)
    if vendor_id:
        vendor_scope |= Q(vendor_id=vendor_id)
    candidates = SlaRule.objects.filter(
        vendor_scope & (Q(category="") | Q(category=category)), superseded_at__isnull=True
    )
    return max(candidates, key=lambda rule: rule.specificity) if candidates else None


def terms_for(*, category: str, vendor_id: str | None) -> SlaTerms:
    rule = rule_for(category=category, vendor_id=vendor_id)
    if rule is None:
        return SlaTerms(FALLBACK_CONFIRM_MINUTES, None, None)
    return SlaTerms(rule.confirm_minutes, rule.completion_minutes, rule)


def apply_deadlines(order: ServiceOrder, *, ordered_at: datetime, moment: datetime) -> None:
    """Проставляет сроки подтверждения и исполнения в заявку.

    Срок подтверждения не позже самого оказания: подтверждение, пришедшее
    после вылета, ничего не подтверждает. Срок исполнения отсчитывается
    от планового времени услуги, а не от заказа.
    """
    terms = terms_for(category=order.service.category, vendor_id=order.vendor_id)
    order.sla_confirm_deadline = min(
        ordered_at + timedelta(minutes=terms.confirm_minutes), moment
    )
    order.sla_completion_deadline = (
        moment + timedelta(minutes=terms.completion_minutes)
        if terms.completion_minutes is not None
        else None
    )


def completion_breached(order: ServiceOrder) -> bool:
    """Нарушен ли срок исполнения по фактическому окончанию."""
    if order.sla_completion_deadline is None or order.actual_end_at is None:
        return False
    return order.actual_end_at > order.sla_completion_deadline


def mark_overdue_confirmations() -> int:
    """Отмечает заявки, не подтверждённые к сроку `[ТЗ 3.2.3]` (`SPEC.md § 4.3`).

    Нарушение отмечается один раз: отобранные заявки уже несут флаг
    после первого прохода и во второй не попадают. Заявка перечитывается
    под блокировкой — поставщик мог подтвердить её между выборкой
    и отметкой.
    """
    from comms.services import events as comms_events

    current = clock.now()
    candidate_ids = list(
        ServiceOrder.objects.filter(
            status=ServiceOrderStatus.ORDERED,
            sla_breached=False,
            sla_confirm_deadline__lt=current,
        ).values_list("pk", flat=True)
    )

    marked = 0
    for order_id in candidate_ids:
        with transaction.atomic():
            order = (
                ServiceOrder.objects.select_for_update()
                .select_related("service", "flight")
                .get(pk=order_id)
            )
            if order.status != ServiceOrderStatus.ORDERED or order.sla_breached:
                continue

            order.sla_breached = True
            order.save(update_fields=["sla_breached", "updated_at", "version"])
            audit.record(
                entity_type=AuditEntityType.SERVICE_ORDER,
                entity_id=order.pk,
                action="sla_breached",
                before={"sla_breached": False},
                after={"sla_breached": True},
                comment=f"Срок подтверждения {order.sla_confirm_deadline:%d.%m.%Y %H:%M} UTC истёк",
                source=AuditSource.SYSTEM,
                is_generated=order.is_generated,
            )
            comms_events.order_sla_breached(order)
            marked += 1

    if marked:
        logger.info("отмечено нарушений SLA: %d", marked)
    return marked


@transaction.atomic
def create_rule(
    *,
    category: str,
    vendor_id: str | None,
    confirm_minutes: int,
    completion_minutes: int | None,
    penalty_kind: str,
    penalty_value: Decimal | None,
    actor: User,
) -> SlaRule:
    """Заводит правило и вытесняет действующее правило той же области.

    Прежнее правило не удаляется и не правится: сроки уже оформленных
    заявок взяты из него, и история справочника должна это объяснять.
    """
    current = (
        SlaRule.objects.select_for_update()
        .filter(category=category, vendor_id=vendor_id, superseded_at__isnull=True)
        # Без сортировки по умолчанию: она тянет поставщика внешним
        # соединением, а блокировать строку по внешнему соединению нельзя.
        .order_by("pk")
        .first()
    )
    if current is not None:
        current.superseded_at = clock.now()
        current.save(update_fields=["superseded_at", "updated_at", "version"])

    rule = SlaRule.objects.create(
        category=category,
        vendor_id=vendor_id,
        confirm_minutes=confirm_minutes,
        completion_minutes=completion_minutes,
        penalty_kind=penalty_kind,
        penalty_value=penalty_value if penalty_kind != SlaPenaltyKind.NONE else None,
    )
    audit.record(
        entity_type=AuditEntityType.SETTINGS,
        entity_id=rule.pk,
        action="sla_rule_created",
        actor=actor,
        before=audit.snapshot(current) if current is not None else None,
        after=audit.snapshot(rule),
        comment=f"Вытесняет {current.pk}" if current is not None else "",
    )
    return rule


def follow_flight(order: ServiceOrder, *, previous_moment: datetime, moment: datetime) -> bool:
    """Сдвигает сроки заявки вслед за переносом рейса. Возвращает, изменились ли они.

    Срок исполнения отсчитывается от планового времени услуги: рейс
    перенесли — сдвигается и он, на ту же величину норматива. Срок
    подтверждения не позже самого оказания: при переносе на раньше
    он ужимается до нового времени.
    """
    changed = False
    if order.sla_completion_deadline is not None and previous_moment != moment:
        order.sla_completion_deadline = moment + (order.sla_completion_deadline - previous_moment)
        changed = True
    if order.sla_confirm_deadline is not None and order.sla_confirm_deadline > moment:
        order.sla_confirm_deadline = moment
        changed = True
    return changed
