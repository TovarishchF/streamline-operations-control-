"""Котировки и счета `[ТЗ 3.4.1]`.

Проверяется то, что ломается дороже всего:

* нумерация без дыр и без дублей при параллельной выдаче
  (`BACKEND.md § 3.5`, приёмка M7);
* неизменяемость выставленного документа на трёх уровнях
  (`BACKEND.md § 3.4`);
* счёт строится по **фактическому** количеству, а не по плановому
  (ADR-020), и объясняет расхождение с котировкой.
"""

from __future__ import annotations

import threading
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from django.db import connections, transaction
from rest_framework import status

from accounts.models import Role
from billing.models import DocumentCounter, Invoice, InvoiceStatus, Quote, QuoteStatus
from billing.services import numbering
from core.clock import now
from orders.models import ServiceOrder

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Service, VendorPrice
    from counterparties.models import Client, Vendor, VendorContract
    from flights.models import Flight

pytestmark = pytest.mark.django_db

QUOTES_URL = "/api/v1/quotes"
INVOICES_URL = "/api/v1/invoices"


def idempotent(key: str = "doc-key-00000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture
def completed_order(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> ServiceOrder:
    """Заявка, доведённая до «Выполнена» с фактом, отличным от плана."""
    dispatcher = as_role(Role.DISPATCHER)
    created = dispatcher.post(
        f"/api/v1/flights/{flight.pk}/services",
        {"serviceId": fuel_service.pk, "leg": "departure", "quantity": "1000.0000",
         "vendorId": vendor_alpha.pk},
        format="json",
        headers=idempotent("ord-00000001"),
    )
    assert created.status_code == status.HTTP_201_CREATED, created.data
    order_id = created.json()["id"]

    vendor = as_role(Role.VENDOR, vendor=vendor_alpha, suffix="billing")
    vendor.post(
        f"/api/v1/service-orders/{order_id}/status",
        {"transition": "confirm"}, format="json", headers=idempotent("c-00000001"),
    )
    vendor.post(
        f"/api/v1/service-orders/{order_id}/status",
        {"transition": "begin"}, format="json", headers=idempotent("b-00000001"),
    )
    started = now()
    vendor.post(
        f"/api/v1/service-orders/{order_id}/status",
        {
            "transition": "finish",
            "actualStartAt": started.isoformat(),
            "actualEndAt": (started + timedelta(minutes=35)).isoformat(),
            # Факт больше плана: для топлива это норма (ADR-020)
            "actualQuantity": "1200.0000",
        },
        format="json",
        headers=idempotent("f-00000001"),
    )
    return ServiceOrder.objects.get(pk=order_id)


# ─────────────────────────── Формирование ───────────────────────────


def test_invoice_is_built_from_actual_quantity(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    """В счёт идёт факт, а не план `[ТЗ 3.2.3]`."""
    api = as_role(Role.FINANCE)
    created = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    assert body["status"] == InvoiceStatus.DRAFT
    # Номер присваивается при выставлении, а не при формировании
    assert body["number"] is None
    assert len(body["lines"]) == 1
    assert body["lines"][0]["quantity"] == "1200.0000"
    # Курс зафиксирован в самом документе (`SPEC.md § 7.2`)
    assert body["fx"]["base"] == "RUB"


def test_invoice_totals_are_sum_of_rounded_lines(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    """ADR-002 п. 3: «итого» обязано сходиться с колонкой на экране."""
    api = as_role(Role.FINANCE)
    body = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()

    lines_total = sum(Decimal(line["amount"]["amount"]) for line in body["lines"])
    vat_total = sum(Decimal(line["vatAmount"]["amount"]) for line in body["lines"])

    assert Decimal(body["totals"]["subtotal"]["amount"]) == lines_total
    assert Decimal(body["totals"]["vatTotal"]["amount"]) == vat_total
    assert Decimal(body["totals"]["grandTotal"]["amount"]) == lines_total + vat_total


def test_invoice_without_completed_services_is_refused(
    as_role: Callable[..., APIClient], flight: Flight
) -> None:
    """Выставлять за неоказанное нельзя, и сообщение объясняет, что делать."""
    api = as_role(Role.FINANCE)
    response = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "завершите заявки" in response.json()["error"]["message"]


def test_quote_includes_planned_services(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> None:
    dispatcher = as_role(Role.DISPATCHER)
    dispatcher.post(
        f"/api/v1/flights/{flight.pk}/services",
        {"serviceId": fuel_service.pk, "leg": "departure", "quantity": "1000.0000",
         "vendorId": vendor_alpha.pk},
        format="json",
        headers=idempotent("q-ord-000001"),
    )

    api = as_role(Role.FINANCE, suffix="quote")
    created = api.post(QUOTES_URL, {"flightId": flight.pk}, format="json", headers=idempotent())

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    # В котировке — плановое количество
    assert body["lines"][0]["quantity"] == "1000.0000"


def test_plan_fact_comparison_explains_the_difference(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    completed_order: ServiceOrder,
) -> None:
    """`SPEC.md § 7.2`: видно, за счёт чего счёт отличается от котировки."""
    finance = as_role(Role.FINANCE)
    quote = finance.post(
        QUOTES_URL, {"flightId": flight.pk}, format="json", headers=idempotent("pf-q-000001")
    ).json()

    invoice = finance.post(
        INVOICES_URL,
        {"flightId": flight.pk, "quoteId": quote["id"]},
        format="json",
        headers=idempotent("pf-i-000001"),
    ).json()

    comparison = invoice["planFactComparison"]
    assert len(comparison) == 1
    assert comparison[0]["kind"] == "quantity_changed"
    assert "1000" in comparison[0]["comment"]
    assert "1200" in comparison[0]["comment"]


# ─────────────────────────── Выставление ───────────────────────────


def test_issuing_assigns_number_and_due_date(
    as_role: Callable[..., APIClient],
    flight: Flight,
    completed_order: ServiceOrder,
    client_alpha: Client,
) -> None:
    api = as_role(Role.FINANCE)
    invoice = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()

    issued = api.post(f"{INVOICES_URL}/{invoice['id']}/issue", format="json")
    assert issued.status_code == status.HTTP_200_OK, issued.data

    body = issued.json()
    assert body["status"] == InvoiceStatus.ISSUED
    assert body["number"].startswith("SOC-I-")
    assert body["issuedAt"] is not None
    # Срок оплаты = дата выставления + отсрочка клиента (`DOMAIN.md § 6`)
    assert body["dueDate"] is not None


def test_issued_invoice_cannot_be_issued_twice(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    api = as_role(Role.FINANCE)
    invoice = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()
    api.post(f"{INVOICES_URL}/{invoice['id']}/issue", format="json")

    again = api.post(f"{INVOICES_URL}/{invoice['id']}/issue", format="json")
    assert again.status_code == status.HTTP_400_BAD_REQUEST
    assert again.json()["error"]["code"] == "DOCUMENT_IMMUTABLE"


def test_invoice_has_no_edit_endpoint(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    """Первый уровень неизменяемости: маршрута на изменение нет.

    Отказ приходит раньше разбора метода — правом, потому что действие
    `partial_update` вьюсетом не объявлено вовсе. Важен результат:
    изменить документ запросом нельзя, и сумма остаётся прежней.
    """
    api = as_role(Role.FINANCE)
    invoice = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()
    before = Invoice.objects.get(pk=invoice["id"]).total_amount

    response = api.patch(
        f"{INVOICES_URL}/{invoice['id']}", {"totalAmount": "1.00"}, format="json"
    )
    assert response.status_code in (
        status.HTTP_403_FORBIDDEN,
        status.HTTP_405_METHOD_NOT_ALLOWED,
    )
    assert Invoice.objects.get(pk=invoice["id"]).total_amount == before


def test_issued_invoice_cannot_lose_number_in_database(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    """Третий уровень: ограничение базы.

    Обойти проверку сервиса можно через админку или psql — ограничение
    не обойти ничем (`BACKEND.md § 3.4`).
    """
    from django.db.utils import IntegrityError

    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()["id"]
    api.post(f"{INVOICES_URL}/{invoice_id}/issue", format="json")

    with pytest.raises(IntegrityError), transaction.atomic():
        Invoice.objects.filter(pk=invoice_id).update(number="")


def test_voiding_requires_reason_and_writes_it_to_audit(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    from audit.models import AuditEntityType, AuditEntry

    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    ).json()["id"]
    api.post(f"{INVOICES_URL}/{invoice_id}/issue", format="json")

    without_reason = api.post(f"{INVOICES_URL}/{invoice_id}/void", {}, format="json")
    assert without_reason.status_code == status.HTTP_400_BAD_REQUEST

    voided = api.post(
        f"{INVOICES_URL}/{invoice_id}/void",
        {"reason": "Ошибка в количестве, будет выпущен новый"},
        format="json",
    )
    assert voided.status_code == status.HTTP_200_OK
    assert voided.json()["status"] == InvoiceStatus.VOIDED

    entry = AuditEntry.objects.filter(
        entity_type=AuditEntityType.INVOICE, entity_id=invoice_id, action="voided"
    ).get()
    assert "Ошибка в количестве" in entry.comment


# ─────────────────────────── Нумерация ───────────────────────────


def test_numbering_has_no_gaps_under_concurrency(django_db_blocker: Any) -> None:
    """Сто номеров в десять потоков: без дыр и без дублей.

    Обязательный тест по `BACKEND.md § 3.5`. Именно ради него счётчик —
    отдельная таблица с блокировкой строки, а не последовательность
    Postgres: та пропускает значения при откате транзакции.
    """
    issued: list[str] = []
    lock = threading.Lock()
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            for _ in range(10):
                with transaction.atomic():
                    number = numbering.next_number(numbering.INVOICE)
                with lock:
                    issued.append(number)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            # Каждый поток получает своё соединение: без явного закрытия
            # они остаются открытыми до конца процесса.
            connections.close_all()

    with django_db_blocker.unblock():
        threads = [threading.Thread(target=worker) for _ in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert not errors, errors
    assert len(issued) == 100
    assert len(set(issued)) == 100, "выданы одинаковые номера"

    sequence = sorted(int(number.rsplit("-", 1)[1]) for number in issued)
    assert sequence == list(range(1, 101)), "в нумерации есть дыра"

    counter = DocumentCounter.objects.get(doc_type=numbering.INVOICE, year=now().year)
    assert counter.last_number == 100


# ─────────────────────────── Изоляция данных ───────────────────────────


def test_client_sees_only_own_invoices(
    as_role: Callable[..., APIClient],
    flight: Flight,
    completed_order: ServiceOrder,
    client_alpha: Client,
    client_beta: Client,
) -> None:
    """Тест на протечку данных для портала (`BACKEND.md § 3.7`)."""
    finance = as_role(Role.FINANCE)
    finance.post(INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent())

    own = as_role(Role.CLIENT, client=client_alpha, suffix="own")
    assert len(own.get(INVOICES_URL).json()["data"]) == 1

    other = as_role(Role.CLIENT, client=client_beta, suffix="other")
    assert other.get(INVOICES_URL).json()["data"] == []


def test_dispatcher_cannot_issue_invoice(
    as_role: Callable[..., APIClient], flight: Flight, completed_order: ServiceOrder
) -> None:
    """Счета выставляет финансист, не диспетчер (`SPEC.md § 2.2`)."""
    api = as_role(Role.DISPATCHER, suffix="nobilling")
    response = api.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent()
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_quote_accepted_by_client(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    client_alpha: Client,
) -> None:
    dispatcher = as_role(Role.DISPATCHER)
    dispatcher.post(
        f"/api/v1/flights/{flight.pk}/services",
        {"serviceId": fuel_service.pk, "leg": "departure", "quantity": "1000.0000",
         "vendorId": vendor_alpha.pk},
        format="json",
        headers=idempotent("acc-ord-0001"),
    )

    finance = as_role(Role.FINANCE, suffix="acc")
    quote_id = finance.post(
        QUOTES_URL, {"flightId": flight.pk}, format="json", headers=idempotent("acc-q-00001")
    ).json()["id"]
    finance.post(f"{QUOTES_URL}/{quote_id}/issue", format="json")

    client_api = as_role(Role.CLIENT, client=client_alpha, suffix="acceptor")
    accepted = client_api.post(f"{QUOTES_URL}/{quote_id}/accept", format="json")

    assert accepted.status_code == status.HTTP_200_OK, accepted.data
    assert accepted.json()["status"] == QuoteStatus.ACCEPTED
    assert Quote.objects.get(pk=quote_id).status == QuoteStatus.ACCEPTED
