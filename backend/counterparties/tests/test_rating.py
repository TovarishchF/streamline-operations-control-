"""Рейтинг поставщика `[ТЗ 3.3.1]` (`DOMAIN.md § 7.4`, G-55).

Приёмка M6: у поставщика с менее чем 5 заявками рейтинг не считается.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import VendorInvoice
from core.clock import now
from counterparties.services import rating
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Service
    from counterparties.models import Vendor
    from flights.models import Flight

WEIGHTS = {
    "onTimeConfirm": Decimal("0.30"),
    "slaCompliance": Decimal("0.30"),
    "billing": Decimal("0.20"),
    "quality": Decimal("0.20"),
}


def stats(**overrides: int) -> rating.RatingStats:
    values = {
        "orders": 10,
        "confirmed_on_time": 8,
        "completed": 5,
        "completed_on_time": 4,
        "reconciled": 4,
        "reconciled_clean": 3,
        "quality_score": 4,
    }
    values.update(overrides)
    return rating.RatingStats(**values)


# ─────────────────────────── Формула ───────────────────────────


def test_fewer_than_five_orders_gives_no_rating() -> None:
    result = rating.compute(stats(orders=4, confirmed_on_time=4), WEIGHTS)

    assert result.sufficient_data is False
    assert result.rating is None
    assert result.order_count == 4
    # Составляющие показываются и без итога: видно, из чего он сложится.
    assert result.components["onTimeConfirm"] == Decimal("1.0000")


def test_rating_follows_the_formula() -> None:
    """5 × (0.3·0.8 + 0.3·0.8 + 0.2·0.75 + 0.2·0.8) = 5 × 0.79 = 3.95."""
    result = rating.compute(stats(), WEIGHTS)

    assert result.sufficient_data is True
    assert result.rating == Decimal("3.95")
    assert result.components == {
        "onTimeConfirm": Decimal("0.8000"),
        "slaCompliance": Decimal("0.8000"),
        "billing": Decimal("0.7500"),
        "quality": Decimal("0.8000"),
    }


def test_component_without_data_shares_its_weight() -> None:
    """Без сверок: 5 × (0.24 + 0.24 + 0.16) / 0.8 = 4.00, а не 3.20 и не 4.20."""
    result = rating.compute(stats(reconciled=0, reconciled_clean=0), WEIGHTS)

    assert result.components["billing"] is None
    assert result.rating == Decimal("4.00")


def test_perfect_vendor_gets_five() -> None:
    perfect = stats(
        orders=6,
        confirmed_on_time=6,
        completed=6,
        completed_on_time=6,
        reconciled=6,
        reconciled_clean=6,
        quality_score=5,
    )
    assert rating.compute(perfect, WEIGHTS).rating == Decimal("5.00")


# ─────────────────────────── Счётчики из базы ───────────────────────────


def order(flight: Flight, service: Service, vendor: Vendor, **fields: Any) -> ServiceOrder:
    """Заявка с заданным состоянием.

    Статус ставится обновлением выборки: это набор для подсчёта, а не
    сценарий жизненного цикла — тот проверяется в `orders/tests`.
    """
    status_value = fields.pop("status", ServiceOrderStatus.CONFIRMED)
    fields.setdefault("ordered_at", now() - timedelta(days=3))
    fields.setdefault("sla_confirm_deadline", now() - timedelta(days=3) + timedelta(hours=2))
    created = ServiceOrder.objects.create(
        flight=flight,
        service=service,
        leg="departure",
        airport_icao="UUWW",
        vendor=vendor,
        quantity=Decimal(1),
        **fields,
    )
    ServiceOrder.objects.filter(pk=created.pk).update(status=status_value)
    return created


@pytest.mark.django_db
def test_stats_count_what_the_vendor_answered_for(
    flight: Flight, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    vendor = fuel_vendors["local"]
    on_time = now() - timedelta(days=3, hours=-1)
    for _ in range(3):
        order(flight, fuel_service, vendor, confirmed_at=on_time)
    order(flight, fuel_service, vendor, confirmed_at=on_time, sla_breached=True)
    order(flight, fuel_service, vendor, status=ServiceOrderStatus.REJECTED)
    # Отменили мы до ответа — не его вина и не его заслуга.
    order(flight, fuel_service, vendor, status=ServiceOrderStatus.CANCELLED)
    # Ждёт ответа в пределах срока — судьба не решена.
    order(
        flight,
        fuel_service,
        vendor,
        status=ServiceOrderStatus.ORDERED,
        sla_confirm_deadline=now() + timedelta(hours=1),
    )

    counted = rating.stats_for(vendor)

    assert counted.orders == 5
    assert counted.confirmed_on_time == 3


@pytest.mark.django_db
def test_stats_take_completion_breaches_and_reconciliation(
    flight: Flight, fuel_service: Service, fuel_vendors: dict[str, Vendor]
) -> None:
    vendor = fuel_vendors["local"]
    on_time = now() - timedelta(days=3, hours=-1)
    deadline = now() - timedelta(days=1)
    clean = order(
        flight,
        fuel_service,
        vendor,
        status=ServiceOrderStatus.COMPLETED,
        confirmed_at=on_time,
        sla_completion_deadline=deadline,
    )
    late = order(
        flight,
        fuel_service,
        vendor,
        status=ServiceOrderStatus.COMPLETED,
        confirmed_at=on_time,
        sla_completion_deadline=deadline,
        sla_completion_breached=True,
    )
    # Без срока исполнения нарушать нечего — такая заявка не учитывается.
    order(flight, fuel_service, vendor, status=ServiceOrderStatus.COMPLETED, confirmed_at=on_time)

    VendorInvoice.objects.create(
        vendor=vendor,
        number="СЧ-1",
        issued_at=now(),
        currency="RUB",
        reconciliation={
            "matched": [{"lineIndex": 1, "serviceOrderId": clean.pk}],
            "discrepancies": [
                {"kind": "price_mismatch", "lineIndex": 2, "serviceOrderId": late.pk},
                {"kind": "missing_on_our_side", "lineIndex": 3, "serviceOrderId": None},
            ],
        },
    )

    counted = rating.stats_for(vendor)

    assert (counted.completed, counted.completed_on_time) == (2, 1)
    assert (counted.reconciled, counted.reconciled_clean) == (2, 1)


# ─────────────────────────── API ───────────────────────────


@pytest.mark.django_db
def test_rating_endpoint_explains_the_number(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    fuel_vendors: dict[str, Vendor],
) -> None:
    vendor = fuel_vendors["local"]
    for _ in range(5):
        order(flight, fuel_service, vendor, confirmed_at=now() - timedelta(days=3, hours=-1))

    response = as_role(Role.DISPATCHER).get(f"/api/v1/vendors/{vendor.pk}/rating")

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["sufficientData"] is True
    assert body["orderCount"] == 5
    # Подтверждения в срок 1.0, качество 3/5 = 0.6, остальное без данных:
    # 5 × (0.3·1 + 0.2·0.6) / 0.5 = 4.20.
    assert body["rating"] == "4.20"
    assert body["components"] == {
        "onTimeConfirmRate": "1.0000",
        "slaComplianceRate": None,
        "billingAccuracy": None,
        "qualityScore": "0.6000",
    }
    assert body["weights"] == {
        "onTimeConfirm": "0.30",
        "slaCompliance": "0.30",
        "billing": "0.20",
        "quality": "0.20",
    }


@pytest.mark.django_db
def test_rating_of_a_new_vendor_is_not_invented(
    as_role: Callable[..., APIClient], fuel_vendors: dict[str, Vendor]
) -> None:
    body = as_role(Role.MANAGER).get(f"/api/v1/vendors/{fuel_vendors['cheap'].pk}/rating").json()

    assert body["sufficientData"] is False
    assert body["rating"] is None


@pytest.mark.django_db
def test_rating_of_unknown_vendor_is_not_found(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.DISPATCHER).get("/api/v1/vendors/ven_missing/rating")
    assert response.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.django_db
def test_portal_vendor_cannot_read_ratings(
    as_role: Callable[..., APIClient], fuel_vendors: dict[str, Vendor]
) -> None:
    vendor = fuel_vendors["cheap"]
    response = as_role(Role.VENDOR, vendor=vendor).get(f"/api/v1/vendors/{vendor.pk}/rating")
    assert response.status_code == status.HTTP_403_FORBIDDEN
