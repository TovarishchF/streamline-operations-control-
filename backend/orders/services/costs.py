"""Закупочная стоимость заявки по плану и по факту (`DOMAIN.md § 7.1`, ADR-020).

Цена за единицу, надбавки и минимальная сумма берутся из **снимка**
в заявке (`CLAUDE.md § 3` п. 5), количество — плановое или фактическое.
Для топлива они расходятся на каждом рейсе: заказали тонну, залили
тонну двести, и платить поставщику, выставлять клиенту и считать маржу
по факту нужно за тонну двести.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING

from catalog import services as catalog_services
from core.money import Money

if TYPE_CHECKING:
    from orders.models import ServiceOrder


def cost_for(order: ServiceOrder, quantity: Decimal) -> Money | None:
    """Стоимость заявки на указанное количество. `None` — цена не зафиксирована."""
    if order.purchase_unit_amount is None or not order.purchase_currency:
        return None
    if quantity == order.quantity and order.purchase_cost_amount is not None:
        # Плановая стоимость уже посчитана при заказе — берётся снимок,
        # а не пересчёт: так сумма в заявке и здесь не разойдутся никогда.
        return Money.of(order.purchase_cost_amount, order.purchase_currency)
    return catalog_services.purchase_cost(
        unit_amount=order.purchase_unit_amount,
        currency=order.purchase_currency,
        quantity=quantity,
        surcharges=order.purchase_surcharges,
        min_charge_amount=order.purchase_min_charge_amount,
    )


def actual_quantity(order: ServiceOrder) -> Decimal:
    """Фактическое количество, а пока его нет — плановое."""
    return Decimal(order.actual_quantity if order.actual_quantity is not None else order.quantity)


def planned_cost(order: ServiceOrder) -> Money | None:
    return cost_for(order, Decimal(order.quantity))


def actual_cost(order: ServiceOrder) -> Money | None:
    return cost_for(order, actual_quantity(order))
