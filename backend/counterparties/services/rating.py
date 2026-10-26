"""Рейтинг поставщика `[ТЗ 3.3.1]` (`DOMAIN.md § 7.4`).

```
onTimeConfirmRate = подтверждено в срок / всего заявок
slaComplianceRate = выполнено без нарушения SLA / всего выполненных
billingAccuracy   = заявок без расхождений в сверке / всего в сверке
qualityScore      = manualQualityScore / 5

rating = 5 × (0.30·onTimeConfirmRate + 0.30·slaComplianceRate
            + 0.20·billingAccuracy + 0.20·qualityScore)
```

Рейтинг вычисляется, а не вводится. При менее чем пяти заявках он
не считается — цифра по двум заявкам выглядела бы приговором.

Уточнения формулы (G-55):

* «всего заявок» — заявки, на которые поставщик должен был ответить:
  ушедшие ему и не ждущие ответа в пределах срока. Отменённые нами
  до его ответа не считаются — они не его заслуга и не его вина;
* «нарушение SLA» у выполненных — нарушение срока **исполнения**:
  опоздание с подтверждением уже учтено первой составляющей, и дважды
  наказывать за одно и то же неверно. Учитываются выполненные заявки,
  у которых срок исполнения был задан: без срока нарушать нечего, и
  засчитывать такую заявку как исполненную в срок значило бы выдумывать;
* составляющая без данных (ни одной выполненной заявки, ни одной сверки)
  не считается нулём и не считается единицей — её вес распределяется
  между остальными. Ноль занизил бы рейтинг того, кто ещё не попадал
  в сверку, единица — завысила бы.

Расчёт — чистая функция над счётчиками (`BACKEND.md § 7`): сбор счётчиков
из базы отделён от формулы, и формула проверяется без базы.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING

from django.db.models import Q

from core import clock
from core.models import Settings

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime

    from counterparties.models import Vendor

MIN_ORDERS = 5
COMPONENTS = ("onTimeConfirm", "slaCompliance", "billing", "quality")
RATE_QUANT = Decimal("0.0001")
RATING_QUANT = Decimal("0.01")
MAX_RATING = Decimal(5)


@dataclass(frozen=True, slots=True)
class RatingStats:
    """Счётчики, из которых складывается рейтинг."""

    orders: int
    confirmed_on_time: int
    completed: int
    completed_on_time: int
    reconciled: int
    reconciled_clean: int
    quality_score: int


@dataclass(frozen=True, slots=True)
class Rating:
    sufficient_data: bool
    rating: Decimal | None
    order_count: int
    components: dict[str, Decimal | None]
    weights: dict[str, Decimal]


def _ratio(part: int, whole: int) -> Decimal | None:
    if whole == 0:
        return None
    return (Decimal(part) / Decimal(whole)).quantize(RATE_QUANT, rounding=ROUND_HALF_UP)


def compute(stats: RatingStats, weights: Mapping[str, Decimal]) -> Rating:
    """Рейтинг по счётчикам и весам."""
    components: dict[str, Decimal | None] = {
        "onTimeConfirm": _ratio(stats.confirmed_on_time, stats.orders),
        "slaCompliance": _ratio(stats.completed_on_time, stats.completed),
        "billing": _ratio(stats.reconciled_clean, stats.reconciled),
        "quality": _ratio(stats.quality_score, 5),
    }
    used_weights = {name: weights.get(name, Decimal(0)) for name in COMPONENTS}

    if stats.orders < MIN_ORDERS:
        return Rating(False, None, stats.orders, components, used_weights)

    available = {name: value for name, value in components.items() if value is not None}
    total_weight = sum((used_weights[name] for name in available), Decimal(0))
    if total_weight <= 0:
        return Rating(False, None, stats.orders, components, used_weights)

    # Деление на сумму весов: при полном наборе составляющих и весах,
    # дающих в сумме единицу, это ровно формула `DOMAIN.md § 7.4`; при
    # пропущенной составляющей её вес делится между остальными.
    weighted = sum((used_weights[name] * value for name, value in available.items()), Decimal(0))
    rating = (MAX_RATING * weighted / total_weight).quantize(RATING_QUANT, rounding=ROUND_HALF_UP)
    return Rating(True, rating, stats.orders, components, used_weights)


def weights() -> dict[str, Decimal]:
    """Веса из настроек (`/admin/sla`), десятичными, а не числами с плавающей точкой."""
    raw = Settings.get_solo().sla_weights or {}
    return {name: Decimal(str(raw.get(name, "0"))) for name in COMPONENTS}


def stats_for(
    vendor: Vendor, *, since: datetime | None = None, until: datetime | None = None
) -> RatingStats:
    """Счётчики по заявкам поставщика, при необходимости — за период заказа."""
    from billing.models import VendorInvoice
    from orders.models import ServiceOrder, ServiceOrderStatus

    current = clock.now()
    sent = ServiceOrder.objects.filter(vendor=vendor, ordered_at__isnull=False)
    if since is not None:
        sent = sent.filter(ordered_at__gte=since)
    if until is not None:
        sent = sent.filter(ordered_at__lte=until)

    awaiting = Q(
        status=ServiceOrderStatus.ORDERED,
        sla_breached=False,
        sla_confirm_deadline__gte=current,
    )
    cancelled_before_answer = Q(status=ServiceOrderStatus.CANCELLED, confirmed_at__isnull=True)
    answerable = sent.exclude(awaiting).exclude(cancelled_before_answer)

    completed = sent.filter(
        status=ServiceOrderStatus.COMPLETED, sla_completion_deadline__isnull=False
    )

    order_ids = set(sent.values_list("pk", flat=True))
    clean: set[str] = set()
    disputed: set[str] = set()
    for result in VendorInvoice.objects.filter(vendor=vendor).values_list(
        "reconciliation", flat=True
    ):
        for item in (result or {}).get("matched", []):
            clean.add(str(item.get("serviceOrderId")))
        for item in (result or {}).get("discrepancies", []):
            if item.get("serviceOrderId"):
                disputed.add(str(item["serviceOrderId"]))
    reconciled = (clean | disputed) & order_ids

    return RatingStats(
        orders=answerable.count(),
        confirmed_on_time=answerable.filter(confirmed_at__isnull=False, sla_breached=False).count(),
        completed=completed.count(),
        completed_on_time=completed.filter(sla_completion_breached=False).count(),
        reconciled=len(reconciled),
        reconciled_clean=len(reconciled - disputed),
        quality_score=vendor.manual_quality_score,
    )


def rating_for(vendor: Vendor) -> Rating:
    return compute(stats_for(vendor), weights())


def to_contract(rating: Rating) -> dict[str, object]:
    """Форма `VendorRating` контракта: десятичные — строками."""
    return {
        "sufficientData": rating.sufficient_data,
        "rating": str(rating.rating) if rating.rating is not None else None,
        "orderCount": rating.order_count,
        "components": {
            "onTimeConfirmRate": _as_str(rating.components["onTimeConfirm"]),
            "slaComplianceRate": _as_str(rating.components["slaCompliance"]),
            "billingAccuracy": _as_str(rating.components["billing"]),
            "qualityScore": _as_str(rating.components["quality"]),
        },
        "weights": {name: str(value) for name, value in rating.weights.items()},
    }


def _as_str(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None
