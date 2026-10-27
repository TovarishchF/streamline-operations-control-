"""Платежи клиентов и статус оплаты счёта `[ТЗ 3.4.1]` (ADR-019).

Статус счёта вычисляется из распределённых платежей и срока, а не
присваивается. Просроченная дебиторка и кредиторка — фоновой задачей
с ключом идемпотентности уведомлений.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from freezegun import freeze_time
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from billing.models import Invoice, InvoiceStatus, Payable
from billing.tasks import check_overdue
from comms.models import Notification
from core.clock import now
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User
    from catalog.models import Service, VendorPrice
    from counterparties.models import Client, Vendor, VendorContract
    from flights.models import Flight

pytestmark = pytest.mark.django_db

URL = "/api/v1/payments"


@pytest.fixture
def invoice(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> Invoice:
    """Выставленный счёт по выполненной заявке. Итог с НДС — из счёта."""
    order = order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal(1000),
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
            "actual_quantity": Decimal(1000),
        },
        actor=dispatcher,
    )
    transitions.apply_transition(order, "finish", actor=dispatcher)

    api = as_role(Role.FINANCE, suffix="inv")
    created = api.post(
        "/api/v1/invoices",
        {"flightId": flight.pk},
        format="json",
        headers={"Idempotency-Key": "pay-inv-0001"},
    ).json()
    api.post(
        f"/api/v1/invoices/{created['id']}/issue",
        format="json",
        headers={"Idempotency-Key": "pay-inv-0002"},
    )
    return Invoice.objects.get(pk=created["id"])


def pay(api: APIClient, invoice: Invoice, amount: str, *, key: str, **extra: Any) -> Any:
    body = {
        "clientId": invoice.client_id,
        "amount": {"amount": amount, "currency": invoice.currency},
        "receivedAt": now().isoformat(),
        "allocations": [
            {"invoiceId": invoice.pk, "amount": {"amount": amount, "currency": invoice.currency}}
        ],
        **extra,
    }
    return api.post(URL, body, format="json", headers={"Idempotency-Key": key})


def test_full_payment_makes_the_invoice_paid(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    api = as_role(Role.FINANCE)
    response = pay(api, invoice, str(invoice.total_amount), key="pay-000001")

    assert response.status_code == status.HTTP_201_CREATED, response.json()
    invoice.refresh_from_db()
    assert invoice.status == InvoiceStatus.PAID
    assert AuditEntry.objects.filter(entity_id=response.json()["id"], action="created").exists()

    body = api.get(f"/api/v1/invoices/{invoice.pk}").json()
    assert body["paidAmount"] == {"amount": str(invoice.total_amount), "currency": "RUB"}


def test_partial_payment_makes_it_partially_paid(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    api = as_role(Role.FINANCE)
    pay(api, invoice, "1000.00", key="pay-000002")

    invoice.refresh_from_db()
    assert invoice.status == InvoiceStatus.PARTIALLY_PAID

    rest = str(invoice.total_amount - Decimal("1000.00"))
    pay(api, invoice, rest, key="pay-000003")
    invoice.refresh_from_db()
    assert invoice.status == InvoiceStatus.PAID


def test_overpayment_of_an_invoice_is_refused(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    response = pay(
        as_role(Role.FINANCE), invoice, str(invoice.total_amount + 100), key="pay-000004"
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "осталось оплатить" in response.json()["error"]["message"]


def test_allocation_beyond_the_payment_is_refused(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    response = as_role(Role.FINANCE).post(
        URL,
        {
            "clientId": invoice.client_id,
            "amount": {"amount": "100.00", "currency": "RUB"},
            "receivedAt": now().isoformat(),
            "allocations": [
                {"invoiceId": invoice.pk, "amount": {"amount": "500.00", "currency": "RUB"}}
            ],
        },
        format="json",
        headers={"Idempotency-Key": "pay-000005"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_invoice_of_another_client_is_refused(
    as_role: Callable[..., APIClient], invoice: Invoice, client_beta: Client
) -> None:
    response = as_role(Role.FINANCE).post(
        URL,
        {
            "clientId": client_beta.pk,
            "amount": {"amount": "100.00", "currency": "RUB"},
            "receivedAt": now().isoformat(),
            "allocations": [
                {"invoiceId": invoice.pk, "amount": {"amount": "100.00", "currency": "RUB"}}
            ],
        },
        format="json",
        headers={"Idempotency-Key": "pay-000006"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "другому клиенту" in response.json()["error"]["message"]


def test_allocation_in_another_currency_is_refused(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    response = as_role(Role.FINANCE).post(
        URL,
        {
            "clientId": invoice.client_id,
            "amount": {"amount": "100.00", "currency": "USD"},
            "receivedAt": now().isoformat(),
            "allocations": [
                {"invoiceId": invoice.pk, "amount": {"amount": "100.00", "currency": "USD"}}
            ],
        },
        format="json",
        headers={"Idempotency-Key": "pay-000007"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_same_external_payment_is_not_registered_twice(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    api = as_role(Role.FINANCE)
    first = pay(api, invoice, "100.00", key="pay-000008", source="onec", externalId="1C-77")
    second = pay(api, invoice, "100.00", key="pay-000009", source="onec", externalId="1C-77")

    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_400_BAD_REQUEST


def test_payment_requires_idempotency_key(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    response = as_role(Role.FINANCE).post(
        URL,
        {
            "clientId": invoice.client_id,
            "amount": {"amount": "100.00", "currency": "RUB"},
            "receivedAt": now().isoformat(),
        },
        format="json",
    )
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_dispatcher_cannot_register_payments(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    response = pay(as_role(Role.DISPATCHER), invoice, "100.00", key="pay-000010")
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_client_sees_only_own_payments(
    as_role: Callable[..., APIClient],
    make_user: Callable[..., User],
    api: APIClient,
    invoice: Invoice,
    client_beta: Client,
) -> None:
    pay(as_role(Role.FINANCE), invoice, "100.00", key="pay-000011")

    api.force_authenticate(user=make_user(Role.CLIENT, suffix="own", client=invoice.client))
    assert api.get(URL).json()["meta"]["total"] == 1

    api.force_authenticate(user=make_user(Role.CLIENT, suffix="other", client=client_beta))
    assert api.get(URL).json()["meta"]["total"] == 0


def test_list_is_filtered_by_invoice(as_role: Callable[..., APIClient], invoice: Invoice) -> None:
    api = as_role(Role.FINANCE)
    pay(api, invoice, "100.00", key="pay-000012")
    assert api.get(f"{URL}?invoiceId={invoice.pk}").json()["meta"]["total"] == 1
    assert api.get(f"{URL}?invoiceId=inv_none").json()["meta"]["total"] == 0


# ─────────────────────────── Просрочка ───────────────────────────


def test_overdue_invoice_and_payable_notify_once(
    invoice: Invoice, make_user: Callable[..., User]
) -> None:
    finance = make_user(Role.FINANCE, suffix="watch")
    assert invoice.due_date is not None
    payable = Payable.objects.get()

    with freeze_time(max(invoice.due_date, payable.due_date) + timedelta(days=1)):
        assert check_overdue() == 2
        check_overdue()

    invoice.refresh_from_db()
    assert invoice.status == InvoiceStatus.OVERDUE
    assert Notification.objects.filter(user=finance, kind="payment_overdue").count() == 2


def test_payment_after_overdue_settles_the_invoice(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    assert invoice.due_date is not None
    with freeze_time(invoice.due_date + timedelta(days=1)):
        check_overdue()
        invoice.refresh_from_db()
        assert invoice.status == InvoiceStatus.OVERDUE

        pay(as_role(Role.FINANCE), invoice, str(invoice.total_amount), key="pay-000013")
        invoice.refresh_from_db()
        assert invoice.status == InvoiceStatus.PAID
