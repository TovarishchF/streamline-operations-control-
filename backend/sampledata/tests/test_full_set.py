"""Полный набор генератора на настоящих справочниках `[ТЗ этап 2]` (`SPEC.md § 11`).

Приёмка M11 требует, чтобы в наборе были «интересные» случаи: отказ
поставщика с переназначением, нарушение SLA, отрицательная маржа, борт
в AOG, истекающий договор, счёт поставщика с тремя типами расхождений,
конфликт расписания, рейс в валюте, отличной от валюты поставщика.
Здесь проверяется, что они есть, что история проведена системой, а не
вписана генератором, и что очистка не задевает введённое людьми.

Набор собирается один раз на всю проверку: генерация на полном справочнике
идёт десятки секунд, и повторять её на каждое утверждение незачем.

Акты выполненных работ — настоящие PDF (WeasyPrint). В образе сервера
сборка PDF есть, на машине разработчика под Windows — как правило нет:
там проверка пропускается, а не подменяется.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from django.core.management import call_command

from audit.models import AuditEntry, AuditSource
from billing.models import FxRate, Invoice, InvoiceStatus, Payable, PayableStatus, VendorInvoice
from billing.services import margin as margin_service
from billing.services import reconciliation
from comms.models import OutboxMessage
from core import clock
from core.models import Attachment, DataSource
from core.services import storage
from counterparties.models import Client, ContractStatus, VendorContract
from fleet.models import Aircraft, AircraftStatus
from flights.models import Flight, FlightStatus
from flights.services import conflicts
from orders.models import ServiceOrder, ServiceOrderStatus
from sampledata.management.commands.seed_sample import NEGATIVE_MARGIN_CLIENT, PENDING_ORDERS

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import User


def weasyprint_available() -> bool:
    try:
        import weasyprint  # noqa: F401
    except (ImportError, OSError):
        return False
    return True


pytestmark = pytest.mark.skipif(
    not weasyprint_available(),
    reason="Акты набора — PDF: WeasyPrint требует Pango и Cairo; в образе сервера они есть",
)


@pytest.fixture
def stored(monkeypatch: pytest.MonkeyPatch) -> dict[str, bytes]:
    """Объектное хранилище в памяти: проверка не ходит в S3."""
    objects: dict[str, bytes] = {}

    def put_bytes(*, key: str, data: bytes, mime_type: str) -> None:
        objects[key] = data

    monkeypatch.setattr(storage, "put_bytes", put_bytes)
    monkeypatch.setattr(storage, "delete_object", lambda key: objects.pop(key, None))
    return objects


@pytest.mark.django_db
def test_full_set(
    settings: object, stored: dict[str, bytes], make_user: Callable[..., User]
) -> None:
    settings.SAMPLE_DATA = True  # type: ignore[attr-defined]
    call_command("seed_reference")
    # Курсы — тестовые значения, а не выдумка набора: генератор курсов
    # не создаёт, документы считаются по тому, что есть в базе.
    today = clock.now().date()
    for days in range(60):
        for currency, rate in (("EUR", Decimal("95.5")), ("USD", Decimal("88.2"))):
            FxRate.objects.create(
                on_date=today - timedelta(days=days),
                currency=currency,
                rate=rate,
                data_source=DataSource.IMPORTED,
            )

    call_command("seed_sample", seed=20260912)

    _assert_volume()
    _assert_interesting_cases()
    _assert_history_is_made_by_the_system(stored)
    _assert_purge_keeps_people(make_user)


def _assert_volume() -> None:
    flights = Flight.objects.filter(is_generated=True)
    assert flights.count() >= 150
    assert ServiceOrder.objects.filter(is_generated=True).count() >= 800
    assert flights.filter(status=FlightStatus.COMPLETED).count() >= 80
    # Будущее расписание живое: часть рейсов в работе, часть только
    # запланирована.
    assert flights.filter(status=FlightStatus.IN_WORK).exists()
    assert flights.filter(status=FlightStatus.PLANNED).exists()


def _assert_interesting_cases() -> None:
    orders = ServiceOrder.objects.filter(is_generated=True)

    replaced = orders.filter(replaced_order__isnull=False).select_related("replaced_order")
    assert replaced.exists(), "нет переназначения после отказа"
    assert all(
        item.replaced_order is not None
        and item.replaced_order.status == ServiceOrderStatus.REJECTED
        for item in replaced
    )

    assert orders.filter(sla_breached=True).exists(), "нет нарушения SLA"

    negative = [
        flight
        for flight in Flight.objects.filter(
            client__name=NEGATIVE_MARGIN_CLIENT, status=FlightStatus.COMPLETED
        )
        if margin_service.margin_for(flight, "fact").margin.amount < 0
    ]
    assert negative, "нет рейса с отрицательной маржой"

    assert Aircraft.objects.filter(status=AircraftStatus.AOG).exists()

    statuses = {contract.status for contract in VendorContract.objects.all()}
    assert ContractStatus.EXPIRING in statuses, "нет истекающего договора"
    assert ContractStatus.EXPIRED in statuses

    invoices = list(VendorInvoice.objects.filter(is_generated=True))
    assert len(invoices) == 12
    kinds = [
        {item["kind"] for item in invoice.reconciliation["discrepancies"]} for invoice in invoices
    ]
    assert sum(1 for found in kinds if found) == 5
    assert any(
        {
            reconciliation.PRICE_MISMATCH,
            reconciliation.QUANTITY_MISMATCH,
            reconciliation.MISSING_ON_OUR_SIDE,
        }
        <= found
        for found in kinds
    ), "нет счёта с тремя типами расхождений"
    assert any(invoice.unmapped_codes for invoice in invoices)

    planned = Flight.objects.filter(is_generated=True, std_utc__gt=clock.now())
    assert any(conflicts.detect(flight) for flight in planned), "нет конфликта расписания"

    assert orders.filter(
        flight__client__settlement_currency="RUB", purchase_currency__in=["EUR", "USD"]
    ).exists(), "нет рейса в валюте, отличной от валюты поставщика"


def _assert_history_is_made_by_the_system(stored: dict[str, bytes]) -> None:
    # Каждая запись генератора помечена, в том числе созданные сервисами.
    for model in (Flight, ServiceOrder, Invoice, Payable, VendorInvoice, Attachment):
        assert not model.objects.filter(is_generated=True).exclude(
            data_source=DataSource.SYNTHETIC
        ).exists(), model.__name__
    # Действия генератора не выдаются за действия людей.
    assert not AuditEntry.objects.filter(is_generated=True).exclude(
        source=AuditSource.SEED
    ).exists()
    assert not AuditEntry.objects.exclude(source=AuditSource.SEED).filter(
        actor_name__in=["Карпов Илья Дмитриевич", "Гордеева Ольга Ивановна"]
    ).exists()
    # О прошедших событиях писем нет: только заявки, ждущие ответа.
    assert OutboxMessage.objects.filter(is_generated=True).count() <= PENDING_ORDERS

    # Услуга с обязательным актом закрыта только с актом.
    completed = ServiceOrder.objects.filter(
        status=ServiceOrderStatus.COMPLETED, service__requires_act_to_complete=True
    )
    assert completed.exists()
    for order in completed[:20]:
        act = order.documents.get(kind="act")
        assert stored[act.storage_key].startswith(b"%PDF")

    invoice_statuses = set(Invoice.objects.values_list("status", flat=True))
    assert {InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_PAID} <= invoice_statuses
    assert InvoiceStatus.OVERDUE in invoice_statuses or InvoiceStatus.ISSUED in invoice_statuses

    payables = Payable.objects.filter(is_generated=True)
    assert payables.filter(status=PayableStatus.APPROVED).exists()
    assert payables.filter(status=PayableStatus.PENDING).exists()
    assert any(payable.is_overdue() for payable in payables.filter(due_date__lt=clock.now()))
    assert not payables.filter(status=PayableStatus.PAID).exists()


def _assert_purge_keeps_people(make_user: Callable[..., User]) -> None:
    person = make_user("dispatcher", suffix="person")
    assert person.organization is not None
    client = Client.objects.create(
        organization=person.organization, name="Клиент, заведённый человеком"
    )

    call_command("seed_sample", purge=True)

    assert Client.objects.filter(pk=client.pk).exists()
    assert type(person).objects.filter(pk=person.pk).exists()
    assert not Flight.objects.filter(is_generated=True).exists()
    assert not ServiceOrder.objects.filter(is_generated=True).exists()
    assert not VendorContract.objects.filter(is_generated=True).exists()
    assert not Attachment.objects.filter(is_generated=True).exists()
