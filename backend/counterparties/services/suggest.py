"""Подбор поставщика `[ТЗ 3.3.2]` (`DOMAIN.md § 7.5`).

Кандидаты — активные поставщики со специализацией по категории услуги,
с действующей ценой в аэропорту и действующим договором на дату оказания:
ровно те, у кого заказ пройдёт блокирующие проверки `SPEC.md § 5.2`.

```
priceScore     = 1 − (cost − minCost) / (maxCost − minCost)   // 1 у самого дешёвого
ratingScore    = rating / 5
proximityScore = база в аэропорту ? 1 : max(0, 1 − distanceKm/200)

total = w_price·priceScore + w_rating·ratingScore + w_prox·proximityScore
```

База поставщика — аэропорты из его покрытия. Расстояние считается
от ближайшей базы до аэропорта заказа; поставщик без баз получает
нулевую близость, а не выдуманное расстояние.

Цены кандидатов сравниваются в одной валюте — валюте рейса, если рейс
указан, иначе в рублях — по снимку курсов. Сравнивать 100 евро
со 100 рублями значило бы выбирать по цифре, а не по цене.

Влияние на маржу (`SPEC.md § 7.4`) — насколько изменится маржа рейса,
если заказать услугу у кандидата: вклад кандидата (цена продажи по тарифу
клиента минус закупка) минус вклад текущей заявки на ту же услугу.
Считается по тарифу, а не разницей закупок: при «закупке плюс наценка»
более дешёвый поставщик маржу уменьшает, и показывать обратное нельзя.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Any

from billing.services import fx
from billing.services import tariffs as tariff_service
from catalog import services as catalog_services
from catalog.models import Airport
from core import geo
from core.models import Settings
from core.money import BASE_CURRENCY, Money
from counterparties import services as counterparty_services
from counterparties.services import rating as rating_service

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime

    from catalog.models import Service, VendorPrice
    from counterparties.models import Vendor
    from flights.models import Flight

PRESETS: dict[str, dict[str, Decimal]] = {
    "price": {"price": Decimal(1), "rating": Decimal(0), "proximity": Decimal(0)},
    "rating": {"price": Decimal(0), "rating": Decimal(1), "proximity": Decimal(0)},
    "proximity": {"price": Decimal(0), "rating": Decimal(0), "proximity": Decimal(1)},
}
MODES = ("price", "rating", "proximity", "balanced", "custom")
PROXIMITY_RADIUS_KM = Decimal(200)
SCORE_QUANT = Decimal("0.0001")


@dataclass(frozen=True, slots=True)
class Candidate:
    vendor: Vendor
    price: VendorPrice
    cost: Money
    price_score: Decimal
    rating_score: Decimal
    proximity_score: Decimal
    total_score: Decimal
    distance_km: Decimal | None
    has_base: bool
    margin_impact: Money | None


def weights_for(mode: str, custom: Mapping[str, Any] | None = None) -> dict[str, Decimal]:
    """Веса режима. «Сбалансированный» берётся из настроек, «свой» — из запроса."""
    if mode in PRESETS:
        return dict(PRESETS[mode])
    source: Mapping[str, Any]
    if mode == "custom":
        source = custom or {}
    else:
        source = Settings.get_solo().vendor_suggest_weights or {}
    return {name: Decimal(str(source.get(name, "0"))) for name in ("price", "rating", "proximity")}


def _contribution(
    *,
    cost: Money,
    quantity: Decimal,
    service: Service,
    airport_icao: str,
    flight: Flight,
    rates: Mapping[str, Decimal | str],
    moment: datetime,
) -> Money:
    """Вклад заявки в маржу рейса: цена продажи по тарифу минус закупка."""
    sale = tariff_service.price_for(
        cost=cost,
        quantity=quantity,
        client_id=flight.client_id,
        service_id=service.pk,
        category=service.category,
        airport_icao=airport_icao,
        target_currency=flight.billing_currency,
        rates=rates,
        moment=moment,
    )
    return (sale.amount - fx.convert(cost, flight.billing_currency, rates)).rounded()


def _current_contribution(
    *,
    service: Service,
    airport_icao: str,
    flight: Flight,
    rates: Mapping[str, Decimal | str],
    moment: datetime,
) -> Money:
    """Вклад действующей заявки на ту же услугу. Ноль, если заявки нет."""
    from orders.models import ServiceOrder, ServiceOrderStatus
    from orders.services import costs

    current = (
        ServiceOrder.objects.filter(
            flight=flight,
            service=service,
            airport_icao=airport_icao,
            purchase_unit_amount__isnull=False,
        )
        .exclude(status__in=(ServiceOrderStatus.CANCELLED, ServiceOrderStatus.REJECTED))
        .order_by("-created_at")
        .first()
    )
    cost = costs.planned_cost(current) if current is not None else None
    if current is None or cost is None:
        return Money.zero(flight.billing_currency)
    return _contribution(
        cost=cost,
        quantity=Decimal(current.quantity),
        service=service,
        airport_icao=airport_icao,
        flight=flight,
        rates=rates,
        moment=moment,
    )


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(SCORE_QUANT, rounding=ROUND_HALF_UP)


def _distance_km(vendor: Vendor, airport: Airport | None) -> tuple[bool, Decimal | None]:
    """Есть ли база в аэропорту и расстояние от ближайшей базы, км."""
    bases = [code.upper() for code in vendor.coverage_airports or []]
    if airport is None:
        return False, None
    if airport.icao in bases:
        return True, Decimal(0)
    coordinates = list(
        Airport.objects.filter(icao__in=bases).values_list("lat", "lon")
    )
    if not coordinates:
        return False, None
    nearest_nm = min(
        geo.distance_nm(float(lat), float(lon), float(airport.lat), float(airport.lon))
        for lat, lon in coordinates
    )
    # Расстояние — величина геометрическая, а не денежная: гаверсинус
    # считается в числах с плавающей точкой и только результат переводится
    # в десятичное для баллов.
    return False, Decimal(str(round(nearest_nm * geo.KM_PER_NAUTICAL_MILE, 1)))


def suggest(
    *,
    service: Service,
    airport_icao: str,
    moment: datetime,
    quantity: Decimal,
    mode: str,
    custom_weights: Mapping[str, Any] | None = None,
    flight: Flight | None = None,
) -> list[Candidate]:
    """Кандидаты по убыванию итогового балла, при равенстве — по цене."""
    icao = airport_icao.upper()
    weights = weights_for(mode, custom_weights)
    currency = flight.billing_currency if flight is not None else BASE_CURRENCY
    rates = (flight.fx_snapshot or {}).get("rates") if flight is not None else None
    if not rates:
        rates = fx.snapshot(moment.date())["rates"]
    airport = Airport.objects.filter(icao=icao).first()

    current = (
        _current_contribution(
            service=service, airport_icao=icao, flight=flight, rates=rates, moment=moment
        )
        if flight is not None
        else None
    )

    rows: list[tuple[Vendor, VendorPrice, Money, Decimal, bool, Decimal | None, Money | None]] = []
    for price in catalog_services.candidates_at(
        service_id=service.pk, airport_icao=icao, moment=moment
    ):
        vendor = price.vendor
        if service.category not in (vendor.specializations or []):
            continue
        if counterparty_services.active_contract_for(vendor_id=vendor.pk, moment=moment) is None:
            continue
        cost = catalog_services.purchase_cost(
            unit_amount=price.amount,
            currency=price.currency,
            quantity=quantity,
            surcharges=price.surcharges,
            min_charge_amount=price.min_charge_amount,
        )
        comparable = fx.convert(cost, currency, rates)
        rated = rating_service.rating_for(vendor)
        rating_score = (
            _quantize(rated.rating / rating_service.MAX_RATING)
            if rated.rating is not None
            else _quantize(Decimal(0))
        )
        has_base, distance = _distance_km(vendor, airport)
        impact = (
            _contribution(
                cost=cost,
                quantity=quantity,
                service=service,
                airport_icao=icao,
                flight=flight,
                rates=rates,
                moment=moment,
            )
            - current
            if flight is not None and current is not None
            else None
        )
        rows.append((vendor, price, comparable, rating_score, has_base, distance, impact))

    if not rows:
        return []

    costs = [row[2].amount for row in rows]
    low, high = min(costs), max(costs)

    candidates: list[Candidate] = []
    for vendor, price, cost, rating_score, has_base, distance, impact in rows:
        # Все баллы — с одной точностью: в таблице сравнения «1» рядом
        # с «0.5000» читается как разная природа чисел.
        price_score = _quantize(
            Decimal(1) if high == low else 1 - (cost.amount - low) / (high - low)
        )
        if has_base:
            proximity_score = _quantize(Decimal(1))
        elif distance is None:
            proximity_score = _quantize(Decimal(0))
        else:
            proximity_score = _quantize(max(Decimal(0), 1 - distance / PROXIMITY_RADIUS_KM))

        total = _quantize(
            weights["price"] * price_score
            + weights["rating"] * rating_score
            + weights["proximity"] * proximity_score
        )
        candidates.append(
            Candidate(
                vendor=vendor,
                price=price,
                cost=cost.rounded(),
                price_score=price_score,
                rating_score=rating_score,
                proximity_score=proximity_score,
                total_score=total,
                distance_km=distance,
                has_base=has_base,
                margin_impact=impact,
            )
        )

    return sorted(candidates, key=lambda item: (-item.total_score, item.cost.amount))


def to_contract(candidate: Candidate) -> dict[str, Any]:
    """Форма `VendorCandidate` контракта."""
    return {
        "vendorId": candidate.vendor.pk,
        "vendorName": candidate.vendor.name,
        "cost": candidate.cost.to_json(),
        "priceScore": str(candidate.price_score),
        "ratingScore": str(candidate.rating_score),
        "proximityScore": str(candidate.proximity_score),
        "totalScore": str(candidate.total_score),
        # Расстояние — не деньги: число в JSON здесь допустимо и объявлено
        # контрактом как number.
        "distanceKm": float(candidate.distance_km) if candidate.distance_km is not None else None,
        "hasBaseAtAirport": candidate.has_base,
        "marginImpact": candidate.margin_impact.to_json() if candidate.margin_impact else None,
    }
