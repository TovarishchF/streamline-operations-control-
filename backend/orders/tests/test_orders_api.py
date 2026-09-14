"""Заказ услуги и её жизненный цикл `[ТЗ 3.2.2, 3.2.3]`.

Главное здесь — два свойства, ради которых сервисный слой и написан:

* снимок цены: изменение прайса не переписывает суммы в уже оформленных
  заявках (`CLAUDE.md § 3` п. 5);
* проверки `SPEC.md § 5.2`: заказ в аэропорту без поставщиков, по истёкшему
  договору и по неактуальной цене блокируется с внятным кодом.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntityType, AuditEntry
from catalog.models import VendorPrice
from core.clock import now
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Service
    from counterparties.models import Client, Vendor, VendorContract
    from flights.models import Flight

pytestmark = pytest.mark.django_db

ORDERS_URL = "/api/v1/service-orders"


def idempotent(key: str = "order-key-000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


def services_url(flight: Flight) -> str:
    return f"/api/v1/flights/{flight.pk}/services"


def payload(service: Service, vendor: Vendor | None = None, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "serviceId": service.pk,
        "leg": "departure",
        "quantity": "1000.0000",
    }
    if vendor is not None:
        body["vendorId"] = vendor.pk
    body.update(overrides)
    return body


# ─────────────────────────── Создание заявки ───────────────────────────


def test_order_is_created_with_price_snapshot(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    api = as_role(Role.DISPATCHER)
    created = api.post(
        services_url(flight),
        payload(fuel_service, vendor_alpha),
        format="json",
        headers=idempotent(),
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    assert body["status"] == ServiceOrderStatus.ORDERED
    assert body["airportIcao"] == "UUWW"
    assert body["purchasePrice"] == {"amount": "70.0000", "currency": "RUB"}
    # 70 × 1000 = 70 000, надбавка 10 % = 7 000, итого 77 000 (`DOMAIN.md § 7.1`)
    assert body["purchaseCost"] == {"amount": "77000.0000", "currency": "RUB"}
    assert body["contractTermsSnapshot"]["deferDays"] == 14
    assert body["slaConfirmDeadline"] is not None
    # Цена продажи считается по тарифам клиента — их пока нет, и выдавать
    # закупку за продажу нельзя (`CLAUDE.md § 4`)
    assert body["salePrice"] is None


def test_price_change_does_not_rewrite_placed_order(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    """Снимок цены (`CLAUDE.md § 3` п. 5) — проверяется, а не обещается."""
    api = as_role(Role.DISPATCHER)
    created = api.post(
        services_url(flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent(),
    )
    order_id = created.json()["id"]

    fuel_price.amount = Decimal("999.0000")
    fuel_price.save(update_fields=["amount"])

    after = api.get(f"{ORDERS_URL}/{order_id}").json()
    assert after["purchasePrice"] == {"amount": "70.0000", "currency": "RUB"}
    assert after["purchaseCost"] == {"amount": "77000.0000", "currency": "RUB"}


def test_order_in_airport_without_vendors_is_blocked(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
) -> None:
    """Проверка 1 `SPEC.md § 5.2`: цены нет вовсе."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        services_url(flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    body = response.json()
    assert body["error"]["code"] == "SERVICE_CHECK_FAILED"
    failed = {check["code"] for check in body["error"]["details"]["checks"] if not check["passed"]}
    assert "availability" in failed
    assert ServiceOrder.objects.count() == 0


def test_order_with_expired_contract_is_blocked(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    fuel_price: VendorPrice,
    contract: VendorContract,
) -> None:
    """Проверка 2: договор истёк к дате оказания."""
    contract.valid_to = now() - timedelta(days=1)
    contract.save(update_fields=["valid_to"])

    api = as_role(Role.DISPATCHER)
    response = api.post(
        services_url(flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    failed = {
        check["code"]
        for check in response.json()["error"]["details"]["checks"]
        if not check["passed"]
    }
    assert "contract_valid" in failed


def test_order_with_price_expiring_before_service_date_is_blocked(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    """Проверка 3: цена действует сегодня, но не на дату оказания.

    Именно этот случай и объясняет, почему проверка смотрит на дату
    оказания, а не на сегодняшнюю.
    """
    fuel_price.valid_to = now() + timedelta(hours=1)
    fuel_price.save(update_fields=["valid_to"])

    api = as_role(Role.DISPATCHER)
    response = api.post(
        services_url(flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    failed = {
        check["code"]
        for check in response.json()["error"]["details"]["checks"]
        if not check["passed"]
    }
    assert "price_valid" in failed


def test_lead_time_violation_requires_reason(
    as_role: Callable[..., APIClient],
    urgent_flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    """Проверка 4 неблокирующая: нарушение требует подтверждения."""
    api = as_role(Role.DISPATCHER)

    refused = api.post(
        services_url(urgent_flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent("lead-a-000001"),
    )
    assert refused.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert refused.json()["error"]["details"]["requiresOverride"] is True

    accepted = api.post(
        services_url(urgent_flight),
        payload(fuel_service, vendor_alpha, overrideReason="Согласовано с поставщиком по телефону"),
        format="json",
        headers=idempotent("lead-b-000002"),
    )
    assert accepted.status_code == status.HTTP_201_CREATED


def test_lead_time_override_reason_goes_to_audit(
    as_role: Callable[..., APIClient],
    urgent_flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    api = as_role(Role.DISPATCHER)
    created = api.post(
        services_url(urgent_flight),
        payload(fuel_service, vendor_alpha, overrideReason="Борт перенесён по погоде"),
        format="json",
        headers=idempotent(),
    )

    entry = AuditEntry.objects.get(
        entity_type=AuditEntityType.SERVICE_ORDER, entity_id=created.json()["id"]
    )
    assert "Борт перенесён по погоде" in entry.comment


def test_order_without_vendor_stays_draft(
    as_role: Callable[..., APIClient], flight: Flight, fuel_service: Service
) -> None:
    """Диспетчер отметил потребность, поставщика подберёт позже."""
    api = as_role(Role.DISPATCHER)
    created = api.post(
        services_url(flight), payload(fuel_service), format="json", headers=idempotent()
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    assert created.json()["status"] == ServiceOrderStatus.DRAFT
    assert created.json()["purchasePrice"] is None


# ─────────────────────────── Жизненный цикл ───────────────────────────


@pytest.fixture
def placed_order(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> ServiceOrder:
    api = as_role(Role.DISPATCHER)
    created = api.post(
        services_url(flight), payload(fuel_service, vendor_alpha), format="json",
        headers=idempotent("placed-000001"),
    )
    assert created.status_code == status.HTTP_201_CREATED, created.data
    return ServiceOrder.objects.get(pk=created.json()["id"])


def test_vendor_confirms_own_order(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    response = api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "confirm"},
        format="json",
        headers=idempotent("confirm-00001"),
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["status"] == ServiceOrderStatus.CONFIRMED
    assert body["confirmedAt"] is not None
    assert body["slaBreached"] is False


def test_confirmation_after_deadline_is_marked_as_sla_breach(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Нарушение фиксируется в момент подтверждения, а не вычисляется потом."""
    placed_order.sla_confirm_deadline = now() - timedelta(hours=1)
    placed_order.save(update_fields=["sla_confirm_deadline"])

    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    response = api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "confirm"},
        format="json",
        headers=idempotent("confirm-00002"),
    )
    assert response.json()["slaBreached"] is True


def test_rejection_without_reason_is_refused(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    response = api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "reject"},
        format="json",
        headers=idempotent("reject-000001"),
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["error"]["code"] == "GUARD_NOT_SATISFIED"


def test_finish_without_actual_data_is_refused(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """В счёт идёт факт, а не план (ADR-020): без факта завершить нельзя."""
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "confirm"}, format="json", headers=idempotent("c-000001"),
    )
    api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "begin"}, format="json", headers=idempotent("b-000001"),
    )

    response = api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "finish"}, format="json", headers=idempotent("f-000001"),
    )
    assert response.status_code == status.HTTP_409_CONFLICT
    messages = " ".join(
        item["message"] for item in response.json()["error"]["details"]["unmetConditions"]
    )
    assert "фактическое" in messages.lower()


def test_finish_with_actual_data_completes_order(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "confirm"}, format="json", headers=idempotent("c-000002"),
    )
    api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "begin"}, format="json", headers=idempotent("b-000002"),
    )

    started = now()
    response = api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {
            "transition": "finish",
            "actualStartAt": started.isoformat(),
            "actualEndAt": (started + timedelta(minutes=40)).isoformat(),
            "actualQuantity": "1042.5000",
        },
        format="json",
        headers=idempotent("f-000002"),
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["status"] == ServiceOrderStatus.COMPLETED
    # Фактическое количество отличается от планового — так и должно быть
    assert body["actualQuantity"] == "1042.5000"
    assert body["quantity"] == "1000.0000"


def test_finish_without_act_is_refused_when_act_required(
    as_role: Callable[..., APIClient],
    flight: Flight,
    handling_service_with_act: Any,
    vendor_alpha: Vendor,
    contract: VendorContract,
    airport_departure: Any,
) -> None:
    VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=handling_service_with_act,
        airport_icao="UUWW",
        amount=Decimal("45000.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=10),
        valid_to=now() + timedelta(days=100),
    )

    dispatcher = as_role(Role.DISPATCHER)
    created = dispatcher.post(
        services_url(flight),
        payload(handling_service_with_act, vendor_alpha, quantity="1.0000"),
        format="json",
        headers=idempotent("act-000001"),
    )
    order_id = created.json()["id"]

    api = as_role(Role.VENDOR, vendor=vendor_alpha, suffix="act")
    api.post(
        f"{ORDERS_URL}/{order_id}/status",
        {"transition": "confirm"}, format="json", headers=idempotent("ac-00001"),
    )
    api.post(
        f"{ORDERS_URL}/{order_id}/status",
        {"transition": "begin"}, format="json", headers=idempotent("ab-00001"),
    )

    started = now()
    response = api.post(
        f"{ORDERS_URL}/{order_id}/status",
        {
            "transition": "finish",
            "actualStartAt": started.isoformat(),
            "actualEndAt": (started + timedelta(minutes=30)).isoformat(),
            "actualQuantity": "1.0000",
        },
        format="json",
        headers=idempotent("af-00001"),
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    messages = " ".join(
        item["message"] for item in response.json()["error"]["details"]["unmetConditions"]
    )
    assert "акт" in messages.lower()


def test_reassignment_creates_new_order_linked_to_rejected_one(
    as_role: Callable[..., APIClient],
    placed_order: ServiceOrder,
    vendor_alpha: Vendor,
    organization: Any,
    fuel_service: Service,
    airport_departure: Any,
) -> None:
    """Отказ поставщика — факт истории, его не стирают `[ТЗ 3.3.2]`."""
    from counterparties.models import Vendor as VendorModel

    other = VendorModel.objects.create(
        organization=organization, name="Запасной Поставщик Топлива"
    )
    from counterparties.models import VendorContract as ContractModel

    ContractModel.objects.create(
        vendor=other,
        number="ДГ-2026-2002",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=300),
        currency="RUB",
        payment_defer_days=7,
    )
    VendorPrice.objects.create(
        vendor=other,
        service=fuel_service,
        airport_icao="UUWW",
        amount=Decimal("74.5000"),
        currency="RUB",
        valid_from=now() - timedelta(days=10),
        valid_to=now() + timedelta(days=100),
    )

    vendor_api = as_role(Role.VENDOR, vendor=vendor_alpha)
    vendor_api.post(
        f"{ORDERS_URL}/{placed_order.pk}/status",
        {"transition": "reject", "comment": "Нет свободного топливозаправщика"},
        format="json",
        headers=idempotent("rj-000001"),
    )

    dispatcher = as_role(Role.DISPATCHER, suffix="reassign")
    response = dispatcher.post(
        f"{ORDERS_URL}/{placed_order.pk}/reassign",
        {"vendorId": other.pk, "comment": "Переназначено после отказа"},
        format="json",
        headers=idempotent("rs-000001"),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    body = response.json()
    assert body["replacedOrderId"] == placed_order.pk
    assert body["vendorId"] == other.pk
    # Новый снимок цены: переназначение — это новая договорённость
    assert body["purchasePrice"] == {"amount": "74.5000", "currency": "RUB"}

    # Перечитываем запись, а не `refresh_from_db()`: присвоение защищённому
    # полю FSM запрещено, и обновление на месте возбудило бы исключение.
    rejected = ServiceOrder.objects.get(pk=placed_order.pk)
    assert rejected.status == ServiceOrderStatus.REJECTED
    assert rejected.rejection_reason == "Нет свободного топливозаправщика"


# ─────────────────────────── Изоляция данных ───────────────────────────


def test_vendor_sees_only_own_orders(
    as_role: Callable[..., APIClient],
    placed_order: ServiceOrder,
    vendor_alpha: Vendor,
    organization: Any,
) -> None:
    """Тест на протечку данных для портала (`BACKEND.md § 3.7`)."""
    from counterparties.models import Vendor as VendorModel

    stranger = VendorModel.objects.create(organization=organization, name="Чужой Поставщик")

    own = as_role(Role.VENDOR, vendor=vendor_alpha)
    assert len(own.get(ORDERS_URL).json()["data"]) == 1

    other = as_role(Role.VENDOR, vendor=stranger, suffix="stranger")
    assert other.get(ORDERS_URL).json()["data"] == []
    # Чужая заявка даёт 404, а не 403: её существование не раскрывается
    assert other.get(f"{ORDERS_URL}/{placed_order.pk}").status_code == status.HTTP_404_NOT_FOUND


def test_client_does_not_reach_service_orders_at_all(
    as_role: Callable[..., APIClient], placed_order: ServiceOrder, client_alpha: Client
) -> None:
    """По матрице `SPEC.md § 2.2` заявки на услуги клиенту не показываются.

    Он видит свои рейсы и свои документы; кто и по какой цене оказывает
    услугу — не его дело. Фильтр по арендатору на вьюсете всё равно
    объявлен: если право когда-нибудь выдадут, выборка уже ограничена.
    """
    api = as_role(Role.CLIENT, client=client_alpha)
    assert api.get(ORDERS_URL).status_code == status.HTTP_403_FORBIDDEN
