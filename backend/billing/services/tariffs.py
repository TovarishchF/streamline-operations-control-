"""Цена продажи заявки по тарифам клиента `[ТЗ 3.4.1]` (`DOMAIN.md § 7.2`).

Выбор правила:

    приоритет = (3 за serviceId | 2 за category | 1 за «всё») + 1 если совпал airportIcao

Максимальный приоритет выигрывает; при равенстве — максимальный `validFrom`.
Если подходящих правил нет — наценка по умолчанию из настроек системы.

Расчёт:

    cost_plus:     sale = cost × (1 + markupPercent/100)
    fixed:         sale = price × quantity
    pass_through:  sale = cost
    затем:         sale = sale − discount

Валюта: `cost` может быть в валюте поставщика, `sale` — всегда в валюте
рейса. Конвертация по снимку курса документа, а не по сегодняшнему:
пересчёт выставленного документа по новому курсу менял бы его сумму.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

from billing.models import TariffMode, TariffRule
from core.models import Settings
from core.money import Money, convert

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime

    from orders.models import ServiceOrder


@dataclass(frozen=True, slots=True)
class SalePrice:
    """Цена продажи и объяснение, откуда она взялась.

    Объяснение — не украшение: `[ТЗ 3.4.1]` требует песочницу, которая
    показывает, какое правило сработало и почему. Возвращать одну сумму
    значило бы делать эту песочницу невозможной.
    """

    amount: Money
    rule: TariffRule | None
    explanation: str


def applicable_rules(
    *, client_id: str, service_id: str, category: str, airport_icao: str, moment: datetime
) -> list[TariffRule]:
    """Правила клиента, подходящие к заявке на дату оказания.

    Выборка по связям, а не фильтрация в Python: правил у крупного клиента
    десятки, а заявок на рейс — тоже десятки, и произведение считать
    в приложении незачем.
    """
    from django.db.models import Q

    scope = (
        Q(service_id=service_id)
        | Q(category=category, service__isnull=True)
        | Q(category="", service__isnull=True)
    )
    airport = Q(airport_icao="") | Q(airport_icao=airport_icao)

    return list(
        TariffRule.objects.filter(
            Q(client_id=client_id, valid_from__lte=moment, valid_to__gte=moment) & scope & airport
        )
    )


def pick_rule(rules: list[TariffRule]) -> TariffRule | None:
    """Самое специфичное правило; при равенстве — самое позднее."""
    if not rules:
        return None
    return max(rules, key=lambda rule: (rule.priority, rule.valid_from))


def sale_price(
    *,
    order: ServiceOrder,
    client_id: str,
    target_currency: str,
    rates: Mapping[str, Decimal | str],
    moment: datetime,
) -> SalePrice:
    """Цена продажи заявки по формуле `DOMAIN.md § 7.2`."""
    cost = Money.of(
        order.purchase_cost_amount or Decimal(0),
        order.purchase_currency or target_currency,
    )
    quantity = order.actual_quantity if order.actual_quantity is not None else order.quantity

    rule = pick_rule(
        applicable_rules(
            client_id=client_id,
            service_id=order.service_id,
            category=order.service.category,
            airport_icao=order.airport_icao,
            moment=moment,
        )
    )

    if rule is None:
        # Правил нет — наценка по умолчанию из настроек системы.
        markup = Settings.get_solo().default_markup_percent
        base = _in_currency(cost, target_currency, rates)
        sale = base + base.percent(markup)
        return SalePrice(
            amount=sale.rounded(),
            rule=None,
            explanation=(
                f"Тарифного правила нет, применена наценка по умолчанию {markup} %"
            ),
        )

    if rule.mode == TariffMode.COST_PLUS:
        markup = rule.markup_percent or Decimal(0)
        base = _in_currency(cost, target_currency, rates)
        sale = base + base.percent(markup)
        explanation = f"Правило «закупка плюс наценка» {markup} %"
    elif rule.mode == TariffMode.FIXED:
        unit = Money.of(rule.fixed_amount or Decimal(0), rule.fixed_currency or target_currency)
        sale = _in_currency(unit.multiply(quantity), target_currency, rates)
        explanation = f"Правило «фиксированная цена» {unit}"
    else:
        sale = _in_currency(cost, target_currency, rates)
        explanation = "Правило «по себестоимости»: наценка не применяется"

    if rule.discount_kind and rule.discount_value:
        discount = (
            sale.percent(rule.discount_value)
            if rule.discount_kind == "percent"
            else Money.of(rule.discount_value, target_currency)
        )
        sale = sale - discount
        explanation += f", скидка {rule.discount_value}"
        explanation += " %" if rule.discount_kind == "percent" else f" {target_currency}"

    return SalePrice(amount=sale.rounded(), rule=rule, explanation=explanation)


def _in_currency(
    value: Money, target_currency: str, rates: Mapping[str, Decimal | str]
) -> Money:
    """Конвертация по снимку курса документа (`CLAUDE.md § 3` п. 5)."""
    if value.currency == target_currency:
        return value
    return convert(value, target_currency, rates)
