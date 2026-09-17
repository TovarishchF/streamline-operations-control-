"""Заявки на оплату поставщикам `[ТЗ 3.4.2]` (`SPEC.md § 7.3`).

Проверяется то, из-за чего с поставщиком ссорятся:

* заявка заводится ровно один раз на выполненную услугу;
* срок оплаты считается от снимка условий контракта, а не от сегодняшнего
  контракта (ADR-025);
* поставщик видит свои заявки и только свои (`BACKEND.md § 3.7`).
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import Payable, PayableStatus
from billing.services import payables
from core.clock import now
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User
    from catalog.models import Service
    from counterparties.models import Vendor
    from flights.models import Flight
    from orders.models import ServiceOrder

pytestmark = pytest.mark.django_db

URL = "/api/v1/payables"


def idempotent(key: str = "pay-key-000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture
def completed_order(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
) -> ServiceOrder:
    """Заявка, доведённая до «Выполнена» сервисным слоем."""
    from orders.models import ServiceOrder as Order

    order = order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal("1000.0000"),
        vendor=vendor_alpha,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )
    transitions.apply_transition(order, "confirm", actor=dispatcher)
    transitions.apply_transition(order, "begin", actor=dispatcher)

    started = now()
    order = order_services.update_order(
        order=order,
        changes={
            "actual_start_at": started,
            "actual_end_at": started + timedelta(minutes=30),
            "actual_quantity": Decimal("1000.0000"),
        },
        actor=dispatcher,
    )
    transitions.apply_transition(order, "finish", actor=dispatcher)
    return Order.objects.get(pk=order.pk)


# ─────────────────────────── Заведение ───────────────────────────


def test_payable_appears_when_the_service_is_completed(
    completed_order: ServiceOrder,
) -> None:
    """`DOMAIN.md § 5.2`: переход `finish` создаёт заявку на оплату."""
    payable = Payable.objects.get(service_orders=completed_order)

    assert payable.status == PayableStatus.PENDING
    assert payable.vendor_id == completed_order.vendor_id
    # Сумма — фактическая закупочная стоимость заявки, а не плановая
    assert payable.amount == completed_order.purchase_cost_amount
    assert payable.number.startswith("SOC-P-")


def test_payable_is_created_once(completed_order: ServiceOrder, dispatcher: User) -> None:
    """Обязательство возникает один раз, сколько бы раз ни позвали."""
    again = payables.create_for_order(order=completed_order, actor=dispatcher)

    assert Payable.objects.filter(service_orders=completed_order).count() == 1
    assert again is not None


def test_due_date_comes_from_the_contract_snapshot(
    completed_order: ServiceOrder, contract: Any
) -> None:
    """ADR-025: обязательство возникло на условиях, бывших на тот момент."""
    payable = Payable.objects.get(service_orders=completed_order)
    assert completed_order.completed_at is not None
    expected = completed_order.completed_at + timedelta(days=contract.payment_defer_days)

    assert payable.due_date == expected


def test_changing_the_contract_does_not_move_the_due_date(
    completed_order: ServiceOrder, contract: Any
) -> None:
    """Снимок, а не ссылка (`CLAUDE.md § 3` п. 5)."""
    payable = Payable.objects.get(service_orders=completed_order)
    before = payable.due_date

    contract.payment_defer_days = 90
    contract.save()

    payable.refresh_from_db()
    assert payable.due_date == before


def test_order_without_vendor_creates_nothing(
    flight: Flight, fuel_service: Service, dispatcher: User
) -> None:
    """Платить некому — обязательства нет."""
    order = order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal("10.0000"),
        vendor=None,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )
    assert payables.create_for_order(order=order, actor=dispatcher) is None


def test_creation_is_written_to_the_audit(completed_order: ServiceOrder) -> None:
    from audit.models import AuditEntry

    payable = Payable.objects.get(service_orders=completed_order)
    entry = AuditEntry.objects.filter(
        entity_type="payable", entity_id=payable.pk, action="created"
    ).first()
    assert entry is not None


# ─────────────────────────── Согласование ───────────────────────────


def test_approve_moves_the_payable(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    payable = Payable.objects.get(service_orders=completed_order)

    api = as_role(Role.FINANCE)
    response = api.post(f"{URL}/{payable.pk}/approve", format="json", headers=idempotent())

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["status"] == PayableStatus.APPROVED

    payable.refresh_from_db()
    assert payable.approved_at is not None
    assert payable.approved_by is not None


def test_approving_twice_is_refused(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    """Повторное согласование ничего не меняет и потому запрещено."""
    payable = Payable.objects.get(service_orders=completed_order)

    api = as_role(Role.FINANCE)
    api.post(f"{URL}/{payable.pk}/approve", format="json", headers=idempotent("a-00000001"))
    again = api.post(
        f"{URL}/{payable.pk}/approve", format="json", headers=idempotent("a-00000002")
    )

    assert again.status_code == status.HTTP_409_CONFLICT
    assert again.json()["error"]["code"] == "PAYABLE_NOT_PENDING"


def test_approval_is_written_to_the_audit(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    from audit.models import AuditEntry

    payable = Payable.objects.get(service_orders=completed_order)
    api = as_role(Role.FINANCE)
    api.post(f"{URL}/{payable.pk}/approve", format="json", headers=idempotent())

    entry = AuditEntry.objects.filter(
        entity_type="payable", entity_id=payable.pk, action="approved"
    ).first()
    assert entry is not None
    assert entry.actor_role == Role.FINANCE


def test_dispatcher_cannot_approve(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    """`SPEC.md § 2.2`: согласование платежей — право финансиста."""
    payable = Payable.objects.get(service_orders=completed_order)

    api = as_role(Role.DISPATCHER)
    response = api.post(f"{URL}/{payable.pk}/approve", format="json", headers=idempotent())
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_approval_requires_idempotency_key(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    payable = Payable.objects.get(service_orders=completed_order)

    api = as_role(Role.FINANCE)
    response = api.post(f"{URL}/{payable.pk}/approve", format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


# ─────────────────────────── Реестр ───────────────────────────


def test_overdue_is_computed_by_the_server(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    """Считать просрочку в браузере значило бы зависеть от часов рабочего места."""
    payable = Payable.objects.get(service_orders=completed_order)
    Payable.objects.filter(pk=payable.pk).update(due_date=now() - timedelta(days=3))

    api = as_role(Role.FINANCE)
    row = api.get(URL).json()["data"][0]
    assert row["isOverdue"] is True


def test_paid_payable_is_never_overdue(completed_order: ServiceOrder) -> None:
    """Срок к оплаченной заявке уже не относится.

    Оплате предшествует согласование, поэтому дата согласования
    проставляется: без неё запись не пройдёт ограничение базы —
    и это верно, оплаченной несогласованной заявки не бывает.
    """
    payable = Payable.objects.get(service_orders=completed_order)
    Payable.objects.filter(pk=payable.pk).update(
        due_date=now() - timedelta(days=3),
        status=PayableStatus.PAID,
        approved_at=now() - timedelta(days=5),
    )

    assert Payable.objects.get(pk=payable.pk).is_overdue() is False


def test_paid_payable_cannot_skip_approval(completed_order: ServiceOrder) -> None:
    """База не даёт завести оплаченную заявку без согласования."""
    from django.db.utils import IntegrityError

    payable = Payable.objects.get(service_orders=completed_order)
    with pytest.raises(IntegrityError):
        Payable.objects.filter(pk=payable.pk).update(status=PayableStatus.PAID)


def test_overdue_filter(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder
) -> None:
    api = as_role(Role.FINANCE)
    assert api.get(f"{URL}?overdue=true").json()["data"] == []

    payable = Payable.objects.get(service_orders=completed_order)
    Payable.objects.filter(pk=payable.pk).update(due_date=now() - timedelta(days=1))
    assert len(api.get(f"{URL}?overdue=true").json()["data"]) == 1


def test_vendor_sees_only_own_payables(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    vendor_alpha: Vendor,
    organization: Any,
) -> None:
    """Тест на протечку данных для портала (`BACKEND.md § 3.7`)."""
    from counterparties.models import Vendor as VendorModel

    stranger = VendorModel.objects.create(organization=organization, name="Чужой Поставщик")

    own = as_role(Role.VENDOR, vendor=vendor_alpha, suffix="own")
    assert len(own.get(URL).json()["data"]) == 1

    other = as_role(Role.VENDOR, vendor=stranger, suffix="other")
    assert other.get(URL).json()["data"] == []


def test_client_portal_has_no_payables(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, client_alpha: Any
) -> None:
    """Расчёты с поставщиками клиенту не показываются вовсе."""
    api = as_role(Role.CLIENT, client=client_alpha)
    assert api.get(URL).status_code == status.HTTP_403_FORBIDDEN
