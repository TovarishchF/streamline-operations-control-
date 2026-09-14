"""Операции над заявками на услуги `[ТЗ 3.2.2, 3.2.3]`.

`BACKEND.md § 3.1`: логика здесь, а не во вьюхах. Главное, ради чего этот
слой существует, — **снимки** (`CLAUDE.md § 3` п. 5): при назначении
поставщика закупочная цена и условия договора копируются в заявку.
Последующее изменение прайса не переписывает суммы, и это проверяется
тестом, а не обещанием.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType
from catalog import services as catalog_services
from core import clock
from core.exceptions import ServiceCheckFailed
from flights.models import ServiceLeg
from orders.models import ServiceOrder, ServiceOrderStatus
from orders.services import checks, transitions

if TYPE_CHECKING:
    from datetime import datetime

    from accounts.models import User
    from catalog.models import Service, VendorPrice
    from counterparties.models import Vendor, VendorContract
    from flights.models import Flight

# Срок на подтверждение заявки поставщиком (`DOMAIN.md § 7.6`). Справочник
# правил SLA по категориям появится вместе с реестром правил; до него
# действует общий срок, и он объявлен здесь одной величиной, а не рассыпан
# по коду.
DEFAULT_CONFIRM_SLA_HOURS = 4


def airport_for_leg(flight: Flight, leg: str) -> str:
    return flight.dep_icao if leg == ServiceLeg.DEPARTURE else flight.arr_icao


def service_moment(flight: Flight, leg: str) -> datetime:
    """Момент оказания услуги: вылет для одного плеча, прилёт для другого.

    Именно на эту дату проверяются договор и цена, а не на сегодняшнюю.
    """
    return flight.std_utc if leg == ServiceLeg.DEPARTURE else flight.sta_utc


def _apply_price_snapshot(
    order: ServiceOrder, *, price: VendorPrice, contract: VendorContract
) -> None:
    """Копирует цену и условия договора в заявку (ADR-022, ADR-025)."""
    order.purchase_unit_amount = price.amount
    order.purchase_currency = price.currency
    order.purchase_min_charge_amount = price.min_charge_amount
    order.purchase_surcharges = price.surcharges
    order.purchase_cost_amount = catalog_services.purchase_cost(
        unit_amount=price.amount,
        currency=price.currency,
        quantity=order.quantity,
        surcharges=price.surcharges,
        min_charge_amount=price.min_charge_amount,
    ).amount
    order.contract = contract
    order.contract_terms_snapshot = {
        "currency": contract.currency,
        "mode": contract.payment_mode,
        "deferDays": contract.payment_defer_days,
    }


def _check_failure(context: checks.OrderContext) -> ServiceCheckFailed:
    """Отказ с перечнем непройденных проверок (`BACKEND.md § 9`)."""
    failures = context.blocking_failures
    return ServiceCheckFailed(
        failures[0].message if len(failures) == 1 else _("Заказ услуги заблокирован проверками"),
        # Ключ `checks` — по `ServiceCheckErrorResponse` контракта: интерфейс
        # показывает этот список рядом с заблокированной кнопкой.
        {
            "checks": [
                {
                    "code": check.code,
                    "passed": check.passed,
                    "blocking": check.blocking,
                    "message": check.message,
                }
                for check in context.checks
            ]
        },
    )


@transaction.atomic
def create_order(
    *,
    flight: Flight,
    service: Service,
    leg: str,
    quantity: Decimal,
    vendor: Vendor | None,
    attributes: dict[str, Any],
    override_reason: str,
    actor: User,
) -> ServiceOrder:
    """Создаёт заявку и, если назначен поставщик, сразу её заказывает.

    Без поставщика заявка остаётся черновиком: это законный случай —
    диспетчер отметил потребность, поставщика подберёт позже.

    С поставщиком выполняются проверки `SPEC.md § 5.2`. Провал блокирующей
    проверки — отказ. Провал неблокирующей требует причины, и причина
    записывается в аудит.
    """
    airport = airport_for_leg(flight, leg)
    moment = service_moment(flight, leg)

    order = ServiceOrder(
        flight=flight,
        service=service,
        leg=leg,
        airport_icao=airport,
        vendor=vendor,
        quantity=quantity,
        attributes=attributes,
        override_reason=override_reason,
        is_demo=flight.is_demo,
    )

    if vendor is None:
        order.save()
        audit.record(
            entity_type=AuditEntityType.SERVICE_ORDER,
            entity_id=order.pk,
            action="created",
            actor=actor,
            after=audit.snapshot(order),
            comment=_("Черновик без поставщика"),
            is_demo=order.is_demo,
        )
        return order

    context = checks.run(
        service=service,
        airport_icao=airport,
        vendor_id=vendor.pk,
        service_moment=moment,
    )

    if context.blocking_failures:
        raise _check_failure(context)

    soft = context.soft_failures
    if soft and not override_reason.strip():
        raise ServiceCheckFailed(
            _("Нарушение требует подтверждения с причиной: %(reasons)s")
            % {"reasons": "; ".join(check.message for check in soft)},
            {
                "requiresOverride": True,
                "checks": [
                    {
                        "code": check.code,
                        "passed": check.passed,
                        "blocking": check.blocking,
                        "message": check.message,
                    }
                    for check in context.checks
                ],
            },
        )

    assert context.price is not None
    assert context.contract is not None
    _apply_price_snapshot(order, price=context.price, contract=context.contract)

    now = clock.now()
    order.ordered_at = now
    order.sla_confirm_deadline = min(
        now + timedelta(hours=DEFAULT_CONFIRM_SLA_HOURS),
        # Дедлайн не может быть позже самого оказания: подтверждение,
        # пришедшее после вылета, ничего не подтверждает.
        moment,
    )
    order.save()
    # Статус меняется переходом, а не присвоением (`CLAUDE.md § 3` п. 3).
    # Метод объявлен динамически из файла автомата, поэтому вызывается
    # по имени: статически его не видно ни здесь, ни в `transitions`.
    transitions.apply_transition_method(order, "order")
    order.save(update_fields=["status", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.SERVICE_ORDER,
        entity_id=order.pk,
        action="ordered",
        actor=actor,
        after=audit.snapshot(order),
        comment=(
            _("Нарушение подтверждено: %(reason)s") % {"reason": override_reason}
            if soft
            else ""
        ),
        is_demo=order.is_demo,
    )
    return order


@transaction.atomic
def assign_vendor(*, order: ServiceOrder, vendor: Vendor, actor: User) -> ServiceOrder:
    """Назначает поставщика черновику и фиксирует снимок цены `[ТЗ 3.3.2]`."""
    if order.status != ServiceOrderStatus.DRAFT:
        raise ServiceCheckFailed(
            _("Поставщика можно назначить только черновику заявки"),
            {"currentStatus": order.status},
        )

    moment = service_moment(order.flight, order.leg)
    context = checks.run(
        service=order.service,
        airport_icao=order.airport_icao,
        vendor_id=vendor.pk,
        service_moment=moment,
    )
    if context.blocking_failures:
        raise _check_failure(context)

    assert context.price is not None
    assert context.contract is not None

    before = audit.snapshot(order)
    order.vendor = vendor
    _apply_price_snapshot(order, price=context.price, contract=context.contract)
    order.save()

    audit.record(
        entity_type=AuditEntityType.SERVICE_ORDER,
        entity_id=order.pk,
        action="vendor_assigned",
        actor=actor,
        before=before,
        after=audit.snapshot(order),
        is_demo=order.is_demo,
    )
    return order


@transaction.atomic
def reassign(
    *, order: ServiceOrder, vendor: Vendor, comment: str, actor: User
) -> ServiceOrder:
    """Переназначение поставщика после отказа `[ТЗ 3.3.2]`.

    Создаёт **новую** заявку со ссылкой на прежнюю, а не правит отклонённую:
    отказ поставщика — факт истории, и стирать его нельзя. Новый снимок
    цены берётся на момент переназначения — это новая договорённость.
    """
    if order.status not in (ServiceOrderStatus.REJECTED, ServiceOrderStatus.CANCELLED):
        raise ServiceCheckFailed(
            _("Переназначение возможно только для отклонённой или отменённой заявки"),
            {"currentStatus": order.status},
        )

    replacement = create_order(
        flight=order.flight,
        service=order.service,
        leg=order.leg,
        quantity=order.quantity,
        vendor=vendor,
        attributes=order.attributes,
        override_reason=comment,
        actor=actor,
    )
    replacement.replaced_order = order
    replacement.save(update_fields=["replaced_order", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.SERVICE_ORDER,
        entity_id=replacement.pk,
        action="reassigned",
        actor=actor,
        after=audit.snapshot(replacement),
        comment=_("Взамен заявки %(id)s: %(comment)s")
        % {"id": order.pk, "comment": comment or "—"},
        is_demo=replacement.is_demo,
    )
    return replacement


@transaction.atomic
def update_order(*, order: ServiceOrder, changes: dict[str, Any], actor: User) -> ServiceOrder:
    """Правка заявки: количество, атрибуты, фактические время и количество."""
    before = audit.snapshot(order)

    for field, value in changes.items():
        setattr(order, field, value)

    # Количество изменилось — закупочная стоимость пересчитывается
    # по тому же снимку цены, а не по текущему прайсу.
    if "quantity" in changes and order.purchase_unit_amount is not None:
        order.purchase_cost_amount = catalog_services.purchase_cost(
            unit_amount=order.purchase_unit_amount,
            currency=order.purchase_currency,
            quantity=order.quantity,
            surcharges=order.purchase_surcharges,
            min_charge_amount=order.purchase_min_charge_amount,
        ).amount

    order.save()

    audit.record(
        entity_type=AuditEntityType.SERVICE_ORDER,
        entity_id=order.pk,
        action="updated",
        actor=actor,
        before=before,
        after=audit.snapshot(order),
        is_demo=order.is_demo,
    )
    return order
