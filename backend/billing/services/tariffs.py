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

Одна функция считает цену для документа, для маржи, для подбора
поставщика и для песочницы тарифа: песочница, считающая не так, как счёт,
объясняла бы не ту цифру, которую увидит клиент.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from billing.models import TariffMode, TariffRule
from billing.services import fx
from core.models import Settings
from core.money import Money

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
    # Шаги расчёта и рассмотренные правила — форма `TariffSimulateResult`.
    steps: list[dict[str, Any]] = field(default_factory=list)
    candidates: list[dict[str, Any]] = field(default_factory=list)


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


def _scope_text(rule: TariffRule) -> str:
    if rule.service_id:
        scope = f"услуга {rule.service.code}" if rule.service else "услуга"
    elif rule.category:
        scope = f"категория {rule.category}"
    else:
        scope = "все услуги"
    if rule.airport_icao:
        scope += f", аэропорт {rule.airport_icao}"
    return scope


def price_for(
    *,
    cost: Money,
    quantity: Decimal,
    client_id: str,
    service_id: str,
    category: str,
    airport_icao: str,
    target_currency: str,
    rates: Mapping[str, Decimal | str],
    moment: datetime,
) -> SalePrice:
    """Цена продажи по закупочной стоимости и тарифам клиента (`DOMAIN.md § 7.2`)."""
    rules = applicable_rules(
        client_id=client_id,
        service_id=service_id,
        category=category,
        airport_icao=airport_icao,
        moment=moment,
    )
    rule = pick_rule(rules)
    candidates = [
        {
            "ruleId": item.pk,
            "priority": item.priority,
            "selected": rule is not None and item.pk == rule.pk,
            "reason": (
                f"{_scope_text(item)}: приоритет {item.priority}, действует с "
                f"{item.valid_from:%d.%m.%Y}"
            ),
        }
        for item in sorted(rules, key=lambda item: (-item.priority, -item.valid_from.timestamp()))
    ]

    base = fx.convert(cost, target_currency, rates)
    steps: list[dict[str, Any]] = [
        {
            "step": "cost",
            "detail": (
                f"Закупочная стоимость {cost}"
                + (f", в валюте расчётов {base}" if cost.currency != target_currency else "")
            ),
            "value": str(base.amount),
        }
    ]

    if rule is None:
        markup = Settings.get_solo().default_markup_percent
        sale = base + base.percent(markup)
        explanation = f"Тарифного правила нет, применена наценка по умолчанию {markup} %"
        steps.append({"step": "rule", "detail": explanation, "value": str(markup)})
        steps.append(
            {"step": "sale", "detail": "Цена продажи", "value": str(sale.rounded().amount)}
        )
        return SalePrice(
            amount=sale.rounded(), rule=None, explanation=explanation, steps=steps,
            candidates=candidates,
        )

    steps.append(
        {
            "step": "rule",
            "detail": (
                f"Выбрано правило «{rule.get_mode_display()}» ({_scope_text(rule)}): "
                f"самый высокий приоритет {rule.priority}"
                + (", при равенстве — самое позднее" if len(rules) > 1 else "")
            ),
            "value": str(rule.priority),
        }
    )

    if rule.mode == TariffMode.COST_PLUS:
        markup = rule.markup_percent or Decimal(0)
        sale = base + base.percent(markup)
        explanation = f"Правило «закупка плюс наценка» {markup} %"
        steps.append({"step": "markup", "detail": f"Наценка {markup} %", "value": str(sale.amount)})
    elif rule.mode == TariffMode.FIXED:
        unit = Money.of(rule.fixed_amount or Decimal(0), rule.fixed_currency or target_currency)
        sale = fx.convert(unit.multiply(quantity), target_currency, rates)
        explanation = f"Правило «фиксированная цена» {unit}"
        steps.append(
            {
                "step": "fixed",
                "detail": f"Фиксированная цена {unit} × {quantity}",
                "value": str(sale.amount),
            }
        )
    else:
        sale = base
        explanation = "Правило «по себестоимости»: наценка не применяется"
        steps.append({"step": "pass_through", "detail": explanation, "value": str(sale.amount)})

    if rule.discount_kind and rule.discount_value:
        discount = (
            sale.percent(rule.discount_value)
            if rule.discount_kind == "percent"
            else Money.of(rule.discount_value, target_currency)
        )
        sale = sale - discount
        suffix = " %" if rule.discount_kind == "percent" else f" {target_currency}"
        explanation += f", скидка {rule.discount_value}{suffix}"
        steps.append(
            {
                "step": "discount",
                "detail": f"Скидка {rule.discount_value}{suffix}",
                "value": str(discount.amount),
            }
        )

    steps.append({"step": "sale", "detail": "Цена продажи", "value": str(sale.rounded().amount)})
    return SalePrice(
        amount=sale.rounded(), rule=rule, explanation=explanation, steps=steps,
        candidates=candidates,
    )


def sale_price(
    *,
    order: ServiceOrder,
    client_id: str,
    target_currency: str,
    rates: Mapping[str, Decimal | str],
    moment: datetime,
    use_actual: bool,
) -> SalePrice:
    """Цена продажи заявки (`DOMAIN.md § 7.2`).

    `use_actual` различает план и факт: котировка и плановая маржа
    считаются по плановому количеству, счёт и фактическая маржа —
    по фактическому (ADR-020). Закупочная стоимость при этом берётся
    из снимка цены, пересчитанного на то же количество, — иначе наценка
    по факту считалась бы от плановой закупки.
    """
    from orders.services import costs

    quantity = costs.actual_quantity(order) if use_actual else Decimal(order.quantity)
    cost = costs.cost_for(order, quantity) or Money.zero(target_currency)
    return price_for(
        cost=cost,
        quantity=quantity,
        client_id=client_id,
        service_id=order.service_id,
        category=order.service.category,
        airport_icao=order.airport_icao,
        target_currency=target_currency,
        rates=rates,
        moment=moment,
    )
