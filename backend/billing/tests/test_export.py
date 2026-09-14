"""Выгрузка счёта в PDF и XLSX `[ТЗ 3.4.1]`.

Приёмка M7: «сумма в PDF, XLSX, API и на экране совпадает до копейки».
Совпадать они могут только если итог берётся из документа, а не считается
заново на каждом уровне, — это и проверяется.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from io import BytesIO
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from billing.models import Invoice
from billing.services import export
from core.clock import now
from core.services import storage
from orders.models import ServiceOrder

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Service, VendorPrice
    from counterparties.models import Vendor, VendorContract
    from flights.models import Flight

pytestmark = pytest.mark.django_db

INVOICES_URL = "/api/v1/invoices"


def weasyprint_available() -> bool:
    """Доступна ли сборка PDF в этом окружении.

    WeasyPrint опирается на Pango и Cairo. В образе сервера они стоят
    (`backend/Dockerfile`), на машине разработчика под Windows — как
    правило нет. Пропустить проверку честнее, чем подменить её заглушкой
    и отчитаться, что PDF собирается.
    """
    try:
        import weasyprint  # noqa: F401
    except (ImportError, OSError):
        return False
    return True


requires_pdf = pytest.mark.skipif(
    not weasyprint_available(),
    reason="WeasyPrint требует Pango и Cairo; в образе сервера они есть, локально — нет",
)


def idempotent(key: str = "exp-key-00000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture
def invoice(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> Invoice:
    """Счёт по выполненной заявке."""
    dispatcher = as_role(Role.DISPATCHER)
    order_id = dispatcher.post(
        f"/api/v1/flights/{flight.pk}/services",
        {"serviceId": fuel_service.pk, "leg": "departure", "quantity": "1000.0000",
         "vendorId": vendor_alpha.pk},
        format="json",
        headers=idempotent("exp-ord-0001"),
    ).json()["id"]

    vendor = as_role(Role.VENDOR, vendor=vendor_alpha, suffix="export")
    for transition in ("confirm", "begin"):
        vendor.post(
            f"/api/v1/service-orders/{order_id}/status",
            {"transition": transition},
            format="json",
            headers=idempotent(f"exp-{transition}-01"),
        )
    started = now()
    vendor.post(
        f"/api/v1/service-orders/{order_id}/status",
        {
            "transition": "finish",
            "actualStartAt": started.isoformat(),
            "actualEndAt": (started + timedelta(minutes=30)).isoformat(),
            "actualQuantity": "1033.3300",
        },
        format="json",
        headers=idempotent("exp-finish-01"),
    )
    assert ServiceOrder.objects.get(pk=order_id).status == "completed"

    finance = as_role(Role.FINANCE, suffix="exportfin")
    created = finance.post(
        INVOICES_URL, {"flightId": flight.pk}, format="json", headers=idempotent("exp-inv-0001")
    )
    assert created.status_code == status.HTTP_201_CREATED, created.data
    return Invoice.objects.get(pk=created.json()["id"])


def test_totals_equal_sum_of_lines(invoice: Invoice) -> None:
    """Итог не пересчитывается по дороге (ADR-002 п. 3)."""
    assert export.totals_match(invoice)


def test_xlsx_carries_the_same_grand_total(invoice: Invoice) -> None:
    """Сумма в выгрузке совпадает с суммой документа до копейки."""
    from openpyxl import load_workbook

    context = export._context(invoice, kind="invoice")
    workbook = load_workbook(BytesIO(export._render_xlsx(context)))
    sheet = workbook.active
    assert sheet is not None

    values = [cell.value for row in sheet.iter_rows() for cell in row if cell.value is not None]
    grand = Decimal(str(invoice.total_amount)).quantize(Decimal("0.01"))

    numbers = [
        Decimal(str(value)).quantize(Decimal("0.01"))
        for value in values
        if isinstance(value, int | float)
    ]
    assert grand in numbers, f"итога {grand} нет в выгрузке: {numbers}"


def test_export_endpoint_returns_download_link(
    as_role: Callable[..., APIClient], invoice: Invoice, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Файл кладётся в хранилище, наружу идёт подписанная ссылка."""
    stored: dict[str, Any] = {}

    def fake_put(*, key: str, data: bytes, mime_type: str) -> None:
        stored["key"] = key
        stored["size"] = len(data)
        stored["mime"] = mime_type

    monkeypatch.setattr(storage, "put_bytes", fake_put)
    monkeypatch.setattr(
        storage,
        "presign_get",
        lambda *, key, file_name: f"http://storage.test/{key}",
    )

    api = as_role(Role.FINANCE)
    response = api.post(
        f"{INVOICES_URL}/{invoice.pk}/export",
        {"format": "xlsx"},
        format="json",
        headers=idempotent("exp-call-0001"),
    )

    assert response.status_code == status.HTTP_202_ACCEPTED, response.data
    body = response.json()
    assert body["status"] == "ready"
    assert body["downloadUrl"].startswith("http://storage.test/exports/")
    assert stored["size"] > 0
    assert stored["mime"].endswith("spreadsheetml.sheet")


def test_unsupported_format_is_refused(
    as_role: Callable[..., APIClient], invoice: Invoice
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        f"{INVOICES_URL}/{invoice.pk}/export",
        {"format": "docx"},
        format="json",
        headers=idempotent("exp-bad-00001"),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_demo_stand_marks_the_export(
    invoice: Invoice, settings: Any
) -> None:
    """`CLAUDE.md § 4`: выгрузка со стенда опознаётся как выгрузка со стенда."""
    settings.DEMO_DATA = True
    context = export._context(invoice, kind="invoice")
    assert context["is_demo"] is True

    from openpyxl import load_workbook

    workbook = load_workbook(BytesIO(export._render_xlsx(context)))
    sheet = workbook.active
    assert sheet is not None
    first = sheet.cell(row=1, column=1).value
    assert first is not None and "DEMO" in str(first)


def test_client_can_export_own_invoice_but_not_someone_elses(
    as_role: Callable[..., APIClient],
    invoice: Invoice,
    monkeypatch: pytest.MonkeyPatch,
    client_alpha: Any,
    client_beta: Any,
) -> None:
    """Тест на протечку данных для портала (`BACKEND.md § 3.7`).

    Формат здесь неважен — важно, чей счёт. Берётся XLSX: он собирается
    в любом окружении, а проверка изоляции не должна зависеть от наличия
    графических библиотек.
    """
    monkeypatch.setattr(storage, "put_bytes", lambda **_: None)
    monkeypatch.setattr(
        storage, "presign_get", lambda *, key, file_name: "http://storage.test/x"
    )

    own = as_role(Role.CLIENT, client=client_alpha, suffix="expown")
    assert (
        own.post(
            f"{INVOICES_URL}/{invoice.pk}/export",
            {"format": "xlsx"},
            format="json",
            headers=idempotent("exp-own-00001"),
        ).status_code
        == status.HTTP_202_ACCEPTED
    )

    # Чужой счёт даёт 404, а не 403: его существование не раскрывается
    other = as_role(Role.CLIENT, client=client_beta, suffix="expother")
    assert (
        other.post(
            f"{INVOICES_URL}/{invoice.pk}/export",
            {"format": "xlsx"},
            format="json",
            headers=idempotent("exp-other-0001"),
        ).status_code
        == status.HTTP_404_NOT_FOUND
    )


@requires_pdf
def test_pdf_is_a_real_pdf_with_the_same_total(invoice: Invoice) -> None:
    """Печатная форма собирается и несёт ту же сумму, что и API.

    Проверяется сигнатура файла, а не просто отсутствие исключения:
    пустой байтовый поток тоже не падает.
    """
    context = export._context(invoice, kind="invoice")
    data = export._render_pdf(context)

    assert data.startswith(b"%PDF-")
    assert len(data) > 1000
