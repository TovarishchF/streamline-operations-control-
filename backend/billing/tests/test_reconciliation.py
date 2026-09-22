"""Сверка счёта поставщика `[ТЗ 3.4.2]` (`DOMAIN.md § 7.7`).

Формула сопоставления проверяется по пунктам: ключ, порядок разбора,
допуск на округление. Ошибка здесь — это деньги, отданные поставщику
не по договорённости либо спор на ровном месте.

Отдельно проверяется, что разбор **предлагает**: решение по расхождению
принимает человек, и каждое решение уходит в аудит.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import Payable, PayableStatus, VendorInvoice
from core.clock import now
from counterparties.models import VendorServiceMapping
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

LIST_URL = "/api/v1/reconciliation"
IMPORT_URL = "/api/v1/reconciliation/import"
MAPPINGS_URL = "/api/v1/vendor-service-mappings"


def idempotent(key: str = "rec-key-000001") -> dict[str, str]:
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
    """Выполненная заявка: 1000 литров по 70, итого 70 000."""
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


def line(
    order: ServiceOrder | None = None,
    *,
    amount: str | None = None,
    quantity: str = "1000.0000",
    code: str = "FUEL-JETA1",
    airport: str = "UUWW",
    shift_days: int = 0,
) -> dict[str, Any]:
    """Строка счёта поставщика.

    По умолчанию сумма берётся из самой заявки: приспособление цены несёт
    надбавку, и захардкоженное число разошлось бы с расчётом при первой
    же правке прайса.
    """
    moment = (_completed(order) if order else now()) + timedelta(days=shift_days)
    if amount is None:
        amount = str(_cost(order).quantize(Decimal("0.01"))) if order else "0.00"
    return {
        "airportIcao": airport,
        "serviceDate": moment.isoformat(),
        "serviceCode": code,
        "quantity": quantity,
        "unitPrice": {"amount": "70.00", "currency": "RUB"},
        "amount": {"amount": amount, "currency": "RUB"},
    }


def _cost(order: ServiceOrder) -> Decimal:
    """Закупочная стоимость выполненной заявки.

    У выполненной она заполнена всегда; сужение типа здесь, а не в каждом
    месте вызова.
    """
    assert order.purchase_cost_amount is not None
    return order.purchase_cost_amount


def _completed(order: ServiceOrder) -> datetime:
    assert order.completed_at is not None
    return order.completed_at


def _dearer(order: ServiceOrder) -> str:
    """Сумма на пять тысяч больше нашей: заведомое расхождение цены."""
    return str((_cost(order) + Decimal("5000")).quantize(Decimal("0.01")))


def invoice_payload(lines: list[dict[str, Any]], *, vendor: Vendor, number: str) -> dict[str, Any]:
    return {
        "vendorId": vendor.pk,
        "number": number,
        "issuedAt": now().isoformat(),
        "currency": "RUB",
        "lines": lines,
    }


# ─────────────────────────── Сопоставление ───────────────────────────


def test_exact_match_gives_no_discrepancy(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Совпало по ключу и по сумме — расхождения нет."""
    api = as_role(Role.FINANCE)
    response = api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-1"),
        format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    result = response.json()["reconciliation"]
    assert len(result["matched"]) == 1
    assert result["discrepancies"] == []
    assert result["delta"]["amount"] == "0.00"


def test_rounding_difference_is_not_a_discrepancy(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """`DOMAIN.md § 7.7`: копейка — арифметика, а не спор."""
    api = as_role(Role.FINANCE)
    response = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=str(_cost(completed_order) + Decimal("0.01")))],
            vendor=vendor_alpha,
            number="V-2",
        ),
        format="json",
        headers=idempotent("rec-round-001"),
    )

    assert response.json()["reconciliation"]["discrepancies"] == []


def test_price_difference_is_a_discrepancy(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-3",
        ),
        format="json",
        headers=idempotent("rec-price-001"),
    ).json()["reconciliation"]

    assert len(result["discrepancies"]) == 1
    found = result["discrepancies"][0]
    assert found["kind"] == "price_mismatch"
    assert Decimal(found["ours"]["amount"]) == _cost(completed_order)
    assert Decimal(found["theirs"]["amount"]) - Decimal(found["ours"]["amount"]) == 5000
    # Положительная разница означает, что поставщик просит больше
    assert result["delta"]["amount"] == "5000.00"


def test_quantity_difference_is_named_by_quantity(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Разное количество объясняет разную сумму — это не спор о цене."""
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order), quantity="1200.0000")],
            vendor=vendor_alpha,
            number="V-4",
        ),
        format="json",
        headers=idempotent("rec-qty-00001"),
    ).json()["reconciliation"]

    assert result["discrepancies"][0]["kind"] == "quantity_mismatch"


def test_line_without_our_order_is_missing_on_our_side(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order), line(completed_order, airport="ULLI", amount="500.00")],
            vendor=vendor_alpha,
            number="V-5",
        ),
        format="json",
        headers=idempotent("rec-extra-001"),
    ).json()["reconciliation"]

    kinds = [item["kind"] for item in result["discrepancies"]]
    assert "missing_on_our_side" in kinds


def test_our_order_without_their_line_is_missing_on_their_side(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Поставщик забыл позицию — это тоже расхождение, и в нашу пользу."""
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, airport="ULLI", amount="500.00")],
            vendor=vendor_alpha,
            number="V-6",
        ),
        format="json",
        headers=idempotent("rec-miss-0001"),
    ).json()["reconciliation"]

    kinds = [item["kind"] for item in result["discrepancies"]]
    assert "missing_on_their_side" in kinds
    found = next(
        item for item in result["discrepancies"] if item["kind"] == "missing_on_their_side"
    )
    assert found["serviceOrderId"] == completed_order.pk
    assert found["theirs"] is None


def test_date_window_of_one_day_still_matches(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Поставщик датирует днём оказания, мы — окончанием работ."""
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, shift_days=1)], vendor=vendor_alpha, number="V-7"
        ),
        format="json",
        headers=idempotent("rec-date-0001"),
    ).json()["reconciliation"]

    assert len(result["matched"]) == 1


def test_date_beyond_the_window_does_not_match(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, shift_days=5)], vendor=vendor_alpha, number="V-8"
        ),
        format="json",
        headers=idempotent("rec-far-00001"),
    ).json()["reconciliation"]

    assert result["matched"] == []


def test_exact_match_wins_over_mismatch(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    vendor_alpha: Vendor,
    flight: Flight,
    fuel_service: Service,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
) -> None:
    """Порядок разбора: сначала все точные совпадения.

    Иначе строка с расхождением заняла бы заявку, которой точно
    соответствует другая строка, и расхождений стало бы два вместо одного.
    """
    api = as_role(Role.FINANCE)
    result = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order)), line(completed_order)],
            vendor=vendor_alpha,
            number="V-9",
        ),
        format="json",
        headers=idempotent("rec-order-001"),
    ).json()["reconciliation"]

    assert len(result["matched"]) == 1
    # Вторая строка осталась непарной, а не «с расхождением цены»
    assert [item["kind"] for item in result["discrepancies"]] == ["missing_on_our_side"]


# ─────────────────────── Номенклатура (ADR-024) ───────────────────────


def test_unknown_vendor_code_goes_to_the_mapping_queue(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Неопознанный код — повод завести соответствие, а не отказ в импорте."""
    api = as_role(Role.FINANCE)
    response = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, code="JET-A1-VENDOR")], vendor=vendor_alpha, number="V-10"
        ),
        format="json",
        headers=idempotent("rec-unmap-001"),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    assert response.json()["unmappedCodes"] == ["JET-A1-VENDOR"]


def test_mapping_makes_the_code_match(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    vendor_alpha: Vendor,
    fuel_service: Service,
) -> None:
    """Решение оператора запоминается и применяется дальше само."""
    VendorServiceMapping.objects.create(
        vendor=vendor_alpha, vendor_code="JET-A1-VENDOR", service=fuel_service
    )

    api = as_role(Role.FINANCE)
    body = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, code="JET-A1-VENDOR")], vendor=vendor_alpha, number="V-11"
        ),
        format="json",
        headers=idempotent("rec-mapped-01"),
    ).json()

    assert body["unmappedCodes"] == []
    assert len(body["reconciliation"]["matched"]) == 1


def test_mapping_can_be_added_through_the_api(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor, fuel_service: Service
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        MAPPINGS_URL,
        {
            "vendorId": vendor_alpha.pk,
            "vendorCode": "  JET-A1  ",
            "vendorName": "Jet A-1 fuel",
            "serviceId": fuel_service.pk,
        },
        format="json",
        headers=idempotent("map-000000001"),
    )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    # Код без обрамляющих пробелов: иначе он не совпал бы сам с собой
    assert response.json()["vendorCode"] == "JET-A1"


def test_same_code_cannot_be_mapped_twice(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor, fuel_service: Service
) -> None:
    VendorServiceMapping.objects.create(
        vendor=vendor_alpha, vendor_code="JET-A1", service=fuel_service
    )

    api = as_role(Role.FINANCE)
    response = api.post(
        MAPPINGS_URL,
        {"vendorId": vendor_alpha.pk, "vendorCode": "JET-A1", "serviceId": fuel_service.pk},
        format="json",
        headers=idempotent("map-000000002"),
    )
    assert response.status_code >= status.HTTP_400_BAD_REQUEST


# ─────────────────────────── Решения ───────────────────────────


def test_resolution_is_recorded_and_audited(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    from audit.models import AuditEntry

    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-12",
        ),
        format="json",
        headers=idempotent("rec-res-00001"),
    ).json()["id"]

    response = api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "accept_theirs", "comment": "Согласовано"},
        format="json",
        headers=idempotent("rec-res-00002"),
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    found = response.json()["reconciliation"]["discrepancies"][0]
    assert found["resolution"] == "accept_theirs"
    assert found["comment"] == "Согласовано"

    entry = AuditEntry.objects.filter(
        entity_type="reconciliation", entity_id=invoice_id, action="discrepancy_resolved"
    ).first()
    assert entry is not None
    assert entry.actor_role == Role.FINANCE


def test_keeping_our_amount_marks_the_payable_disputed(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Своя сумма — это спор, и обязательство помечается спорным."""
    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-13",
        ),
        format="json",
        headers=idempotent("rec-dis-00001"),
    ).json()["id"]

    api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "keep_ours", "comment": "Цена по контракту"},
        format="json",
        headers=idempotent("rec-dis-00002"),
    )

    payable = Payable.objects.get(service_orders=completed_order)
    assert payable.status == PayableStatus.DISPUTED


def test_accepting_their_amount_creates_no_dispute(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-14",
        ),
        format="json",
        headers=idempotent("rec-acc-00001"),
    ).json()["id"]

    api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "accept_theirs"},
        format="json",
        headers=idempotent("rec-acc-00002"),
    )

    payable = Payable.objects.get(service_orders=completed_order)
    assert payable.status == PayableStatus.PENDING


def test_reconciliation_closes_when_all_are_resolved(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-15",
        ),
        format="json",
        headers=idempotent("rec-close-001"),
    ).json()["id"]

    body = api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "accept_theirs"},
        format="json",
        headers=idempotent("rec-close-002"),
    ).json()

    assert body["reconciliation"]["resolvedAt"] is not None
    assert VendorInvoice.objects.get(pk=invoice_id).resolved_at is not None


def test_closed_reconciliation_is_not_reopened(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload(
            [line(completed_order, amount=_dearer(completed_order))],
            vendor=vendor_alpha,
            number="V-16",
        ),
        format="json",
        headers=idempotent("rec-lock-0001"),
    ).json()["id"]

    api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "accept_theirs"},
        format="json",
        headers=idempotent("rec-lock-0002"),
    )
    again = api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 0, "resolution": "keep_ours"},
        format="json",
        headers=idempotent("rec-lock-0003"),
    )

    assert again.status_code == status.HTTP_409_CONFLICT


def test_unknown_discrepancy_index_is_not_found(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-17"),
        format="json",
        headers=idempotent("rec-idx-00001"),
    ).json()["id"]

    response = api.post(
        f"/api/v1/reconciliation/{invoice_id}/resolve",
        {"discrepancyIndex": 7, "resolution": "keep_ours"},
        format="json",
        headers=idempotent("rec-idx-00002"),
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


# ─────────────────────────── Реестр сверок ───────────────────────────


def test_imported_invoice_is_listed(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Без реестра импортированный счёт терялся бы после перезагрузки экрана."""
    api = as_role(Role.FINANCE)
    api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-30"),
        format="json",
        headers=idempotent("rec-list-0001"),
    )

    rows = api.get(LIST_URL).json()["data"]
    assert [row["number"] for row in rows] == ["V-30"]
    # Реестр отдаёт ту же форму, что и карточка: экран рисует список
    # и разбор расхождений одним кодом.
    assert rows[0]["reconciliation"]["discrepancies"] == []
    assert rows[0]["lines"][0]["serviceCode"] == completed_order.service.code


def test_list_is_filtered_by_vendor(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    vendor_alpha: Vendor,
    organization: Any,
) -> None:
    from counterparties.models import Vendor as VendorModel

    other = VendorModel.objects.create(organization=organization, name="Другой Поставщик")
    api = as_role(Role.FINANCE)
    api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-31"),
        format="json",
        headers=idempotent("rec-list-0002"),
    )

    assert len(api.get(f"{LIST_URL}?vendorId={vendor_alpha.pk}").json()["data"]) == 1
    assert api.get(f"{LIST_URL}?vendorId={other.pk}").json()["data"] == []


def test_vendor_portal_does_not_see_reconciliation(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Сверка — внутренний разбор расхождений, а не переписка с поставщиком."""
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    assert api.get(LIST_URL).status_code == status.HTTP_403_FORBIDDEN


# ─────────────────────────── Импорт ───────────────────────────


def test_same_invoice_is_not_imported_twice(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Второй импорт того же счёта дал бы вторую сверку одного обязательства."""
    api = as_role(Role.FINANCE)
    payload = invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-18")

    assert api.post(
        IMPORT_URL, payload, format="json", headers=idempotent("rec-dup-00001")
    ).status_code == status.HTTP_201_CREATED
    again = api.post(IMPORT_URL, payload, format="json", headers=idempotent("rec-dup-00002"))

    assert again.status_code == status.HTTP_400_BAD_REQUEST


def test_import_of_a_missing_vendor_is_not_found(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        IMPORT_URL,
        {
            "vendorId": "ven_00000000000000000000",
            "number": "V-19",
            "issuedAt": now().isoformat(),
            "currency": "RUB",
            "lines": [line()],
        },
        format="json",
        headers=idempotent("rec-novend-01"),
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_empty_invoice_is_refused(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    """Сверять нечего: пустой импорт — ошибка разбора файла."""
    api = as_role(Role.FINANCE)
    response = api.post(
        IMPORT_URL,
        invoice_payload([], vendor=vendor_alpha, number="V-20"),
        format="json",
        headers=idempotent("rec-empty-001"),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_dispatcher_cannot_import(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """`SPEC.md § 2.2`: сверка — право финансиста."""
    api = as_role(Role.DISPATCHER)
    response = api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-21"),
        format="json",
        headers=idempotent("rec-disp-0001"),
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_result_is_a_snapshot_not_a_recomputation(
    as_role: Callable[..., APIClient], completed_order: ServiceOrder, vendor_alpha: Vendor
) -> None:
    """Сверка посчитана по заявкам на момент импорта (`CLAUDE.md § 3` п. 5)."""
    from orders.models import ServiceOrder as Order

    api = as_role(Role.FINANCE)
    before = _cost(completed_order)
    invoice_id = api.post(
        IMPORT_URL,
        invoice_payload([line(completed_order)], vendor=vendor_alpha, number="V-22"),
        format="json",
        headers=idempotent("rec-snap-0001"),
    ).json()["id"]

    # Заявка подорожала задним числом — сверка этого не замечает
    Order.objects.filter(pk=completed_order.pk).update(
        purchase_cost_amount=Decimal("99999.0000")
    )

    body = api.get(f"/api/v1/reconciliation/{invoice_id}").json()
    assert Decimal(body["reconciliation"]["totalOurs"]["amount"]) == before
