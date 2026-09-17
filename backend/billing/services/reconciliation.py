"""Сверка счёта поставщика `[ТЗ 3.4.2]` (`DOMAIN.md § 7.7`, `SPEC.md § 7.3`).

Ключ сопоставления: `поставщик + аэропорт + дата (±1 день) + код услуги`.
Порядок разбора задан формулой и соблюдается буквально:

1. точное совпадение по ключу и сумме;
2. совпадение по ключу с расхождением цены или количества;
3. непарные строки с обеих сторон.

Допуск на округление — 0.01 в валюте документа. В пределах допуска
расхождением не считается: поставщик и мы округляем в разных местах,
и копеечная разница — не спор, а арифметика.

Про номенклатуру. У каждого поставщика свой код услуги, поэтому ключ
опирается на соответствие из справочника (ADR-024). Неопознанный код —
не отказ в импорте, а повод завести соответствие: счёт всё равно нужно
разобрать, и очередь сопоставления для того и существует.

Результат сверки сохраняется **снимком**: он посчитан по заявкам на момент
импорта, и пересчёт при показе дал бы другую сверку, чем ту, по которой
принимали решения.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from audit.models import AuditEntityType
from billing.models import VendorInvoice, VendorInvoiceLine
from core import clock
from core.exceptions import DomainError
from core.money import DISPLAY_QUANT

if TYPE_CHECKING:
    from accounts.models import User
    from counterparties.models import Vendor
    from orders.models import ServiceOrder

# Допуск на округление (`DOMAIN.md § 7.7`).
TOLERANCE = Decimal("0.01")

# Разброс даты в ключе сопоставления: поставщик датирует строку днём
# оказания, а мы — временем окончания работ, и на границе суток они
# расходятся законно.
DATE_WINDOW = timedelta(days=1)

PRICE_MISMATCH = "price_mismatch"
QUANTITY_MISMATCH = "quantity_mismatch"
MISSING_ON_OUR_SIDE = "missing_on_our_side"
MISSING_ON_THEIR_SIDE = "missing_on_their_side"

RESOLUTIONS = ("accept_theirs", "keep_ours", "claim", "investigate")


class InvoiceAlreadyImported(DomainError):
    """Счёт с этим номером от этого поставщика уже импортирован."""

    code = "VALIDATION_ERROR"


class DiscrepancyNotFound(DomainError):
    code = "NOT_FOUND"
    http_status = 404


class ReconciliationAlreadyResolved(DomainError):
    """Сверка закрыта: решения по ней приняты."""

    code = "CONFLICT"
    http_status = 409


@dataclass(frozen=True, slots=True)
class Line:
    """Строка счёта поставщика, приведённая к внутреннему виду."""

    position: int
    airport_icao: str
    service_date: Any
    service_code: str
    service_id: str | None
    quantity: Decimal
    unit_price: Decimal
    amount: Decimal


def _money(amount: Decimal, currency: str) -> dict[str, str]:
    """Денежная величина в форме `Money` из контракта."""
    return {"amount": str(amount.quantize(DISPLAY_QUANT)), "currency": currency}


def mapping_for(vendor_id: str) -> dict[str, str]:
    """Соответствие «код поставщика → наша услуга» (ADR-024)."""
    from counterparties.models import VendorServiceMapping

    return {
        item.vendor_code.strip().upper(): item.service_id
        for item in VendorServiceMapping.objects.filter(vendor_id=vendor_id)
    }


def candidate_orders(vendor: Vendor, lines: list[Line]) -> list[ServiceOrder]:
    """Выполненные заявки поставщика, попадающие в окно дат счёта.

    Выборка сужается до периода счёта: сверять строку счёта за сентябрь
    со всеми заявками за год — лишняя работа и лишние ложные совпадения.
    """
    from orders.models import ServiceOrder, ServiceOrderStatus

    if not lines:
        return []

    dates = [line.service_date for line in lines]
    return list(
        ServiceOrder.objects.filter(
            vendor=vendor,
            status=ServiceOrderStatus.COMPLETED,
            completed_at__gte=min(dates) - DATE_WINDOW,
            completed_at__lte=max(dates) + DATE_WINDOW,
        ).select_related("service")
    )


def _matches(line: Line, order: ServiceOrder) -> bool:
    """Совпадает ли строка счёта с заявкой по ключу `DOMAIN.md § 7.7`."""
    if line.airport_icao.upper() != order.airport_icao.upper():
        return False
    if line.service_id is not None and line.service_id != order.service_id:
        return False
    if line.service_id is None and line.service_code.upper() != order.service.code.upper():
        return False

    completed = order.completed_at
    if completed is None:
        return False
    return bool(abs(completed - line.service_date) <= DATE_WINDOW)


def _order_amount(order: ServiceOrder) -> Decimal:
    return order.purchase_cost_amount or Decimal(0)


def _order_quantity(order: ServiceOrder) -> Decimal:
    quantity = order.actual_quantity if order.actual_quantity is not None else order.quantity
    return Decimal(quantity)


def reconcile(*, vendor: Vendor, currency: str, lines: list[Line]) -> dict[str, Any]:
    """Сопоставляет строки счёта с заявками `[ТЗ 3.4.2]`.

    Возвращает `ReconciliationResult` из контракта.
    """
    orders = candidate_orders(vendor, lines)
    unused = list(orders)

    matched: list[dict[str, Any]] = []
    discrepancies: list[dict[str, Any]] = []
    paired_lines: set[int] = set()

    # Шаг 1: точное совпадение по ключу и сумме. Сначала все точные —
    # иначе строка с расхождением заняла бы заявку, которой точно
    # соответствует другая строка.
    for line in lines:
        exact = next(
            (
                order
                for order in unused
                if _matches(line, order)
                and abs(_order_amount(order) - line.amount) <= TOLERANCE
            ),
            None,
        )
        if exact is not None:
            unused.remove(exact)
            paired_lines.add(line.position)
            matched.append({"lineIndex": line.position, "serviceOrderId": exact.pk})

    # Шаг 2: совпадение по ключу с расхождением.
    for line in lines:
        if line.position in paired_lines:
            continue
        found = next((order for order in unused if _matches(line, order)), None)
        if found is None:
            continue

        unused.remove(found)
        paired_lines.add(line.position)
        ours = _order_amount(found)

        # Количество проверяется раньше цены: разное количество объясняет
        # разную сумму, и называть это расхождением цены было бы неверно.
        kind = (
            QUANTITY_MISMATCH
            if abs(_order_quantity(found) - line.quantity) > TOLERANCE
            else PRICE_MISMATCH
        )
        discrepancies.append(
            {
                "kind": kind,
                "lineIndex": line.position,
                "serviceOrderId": found.pk,
                "ours": _money(ours, currency),
                "theirs": _money(line.amount, currency),
                "resolution": None,
                "comment": None,
            }
        )

    # Шаг 3: непарные строки с обеих сторон.
    for line in lines:
        if line.position in paired_lines:
            continue
        discrepancies.append(
            {
                "kind": MISSING_ON_OUR_SIDE,
                "lineIndex": line.position,
                "serviceOrderId": None,
                "ours": None,
                "theirs": _money(line.amount, currency),
                "resolution": None,
                "comment": None,
            }
        )

    for order in unused:
        discrepancies.append(
            {
                "kind": MISSING_ON_THEIR_SIDE,
                "lineIndex": None,
                "serviceOrderId": order.pk,
                "ours": _money(_order_amount(order), currency),
                "theirs": None,
                "resolution": None,
                "comment": None,
            }
        )

    total_theirs = sum((line.amount for line in lines), Decimal(0))
    total_ours = sum((_order_amount(order) for order in orders), Decimal(0))

    return {
        "matched": matched,
        "discrepancies": discrepancies,
        "totalOurs": _money(total_ours, currency),
        "totalTheirs": _money(total_theirs, currency),
        # Знак осмыслен: положительная разница означает, что поставщик
        # просит больше, чем мы насчитали.
        "delta": _money(total_theirs - total_ours, currency),
        "resolvedAt": None,
    }


def to_lines(payload: list[dict[str, Any]], *, vendor_id: str) -> tuple[list[Line], list[str]]:
    """Приводит строки счёта к внутреннему виду и сопоставляет номенклатуру.

    Вторым значением возвращаются коды, которым соответствия не нашлось:
    они попадают в очередь сопоставления, а не отменяют импорт (ADR-024).
    """
    from catalog.models import Service

    mapping = mapping_for(vendor_id)
    known = set(Service.objects.values_list("code", flat=True))

    lines: list[Line] = []
    unmapped: list[str] = []

    for position, item in enumerate(payload, start=1):
        code = str(item["serviceCode"]).strip()
        service_id = mapping.get(code.upper())

        if service_id is None and code.upper() not in {value.upper() for value in known}:
            # Код не сопоставлен и не совпадает с нашим напрямую.
            if code not in unmapped:
                unmapped.append(code)

        lines.append(
            Line(
                position=position,
                airport_icao=str(item["airportIcao"]).upper(),
                service_date=item["serviceDate"],
                service_code=code,
                service_id=service_id,
                # Числа разбираются из строк: количество и цена приходят
                # десятичными строками (`CLAUDE.md § 3` п. 1).
                quantity=Decimal(str(item["quantity"])),
                unit_price=Decimal(str(item["unitPrice"]["amount"])),
                amount=Decimal(str(item["amount"]["amount"])),
            )
        )

    return lines, unmapped


@transaction.atomic
def import_invoice(
    *,
    vendor: Vendor,
    number: str,
    issued_at: Any,
    currency: str,
    payload: list[dict[str, Any]],
    actor: User,
) -> VendorInvoice:
    """Импортирует счёт поставщика и сразу его сверяет `[ТЗ 3.4.2]`."""
    if VendorInvoice.objects.filter(vendor=vendor, number=number).exists():
        raise InvoiceAlreadyImported(
            _("Счёт %(number)s от этого поставщика уже импортирован")
            % {"number": number},
            {"number": number},
        )

    lines, unmapped = to_lines(payload, vendor_id=vendor.pk)
    result = reconcile(vendor=vendor, currency=currency, lines=lines)

    invoice = VendorInvoice.objects.create(
        vendor=vendor,
        number=number,
        issued_at=issued_at,
        currency=currency,
        reconciliation=result,
        unmapped_codes=unmapped,
    )
    for line in lines:
        VendorInvoiceLine.objects.create(
            invoice=invoice,
            position=line.position,
            airport_icao=line.airport_icao,
            service_date=line.service_date,
            service_code=line.service_code,
            service_id=line.service_id,
            quantity=line.quantity,
            unit_price=line.unit_price,
            amount=line.amount,
        )

    # Заявки на оплату, попавшие в сверку, связываются со счётом:
    # по реестру должно быть видно, чем обязательство подтверждено.
    _link_payables(invoice, result)

    audit.record(
        entity_type=AuditEntityType.RECONCILIATION,
        entity_id=invoice.pk,
        action="imported",
        actor=actor,
        after={
            "number": number,
            "lines": len(lines),
            "discrepancies": len(result["discrepancies"]),
            "unmappedCodes": unmapped,
        },
        is_demo=invoice.is_demo,
    )
    return invoice


def _link_payables(invoice: VendorInvoice, result: dict[str, Any]) -> None:
    from billing.models import Payable

    order_ids = [item["serviceOrderId"] for item in result["matched"]]
    if not order_ids:
        return
    Payable.objects.filter(
        service_orders__in=order_ids, vendor=invoice.vendor
    ).distinct().update(vendor_invoice=invoice)


@transaction.atomic
def resolve(
    *,
    invoice: VendorInvoice,
    index: int,
    resolution: str,
    comment: str,
    actor: User,
) -> VendorInvoice:
    """Решение по расхождению `[ТЗ 3.4.2]`.

    Решения принимает человек и отвечает за них: сумма расхождения —
    это деньги поставщику. Поэтому каждое решение уходит в аудит,
    а «принять счёт поставщика» по спорной позиции дополнительно
    помечает заявку на оплату спорной.
    """
    if invoice.resolved_at is not None:
        raise ReconciliationAlreadyResolved(
            _("Сверка закрыта"), {"resolvedAt": invoice.resolved_at.isoformat()}
        )

    discrepancies: list[dict[str, Any]] = list(
        invoice.reconciliation.get("discrepancies", [])
    )
    if not 0 <= index < len(discrepancies):
        raise DiscrepancyNotFound(
            _("Расхождение %(index)s в этой сверке отсутствует") % {"index": index},
            {"discrepancyIndex": index},
        )
    if resolution not in RESOLUTIONS:
        raise DomainError(
            _("Неизвестное решение по расхождению"), {"resolution": resolution}
        )

    before = dict(discrepancies[index])
    discrepancies[index] = {**before, "resolution": resolution, "comment": comment or None}

    reconciliation = dict(invoice.reconciliation)
    reconciliation["discrepancies"] = discrepancies

    # Сверка закрывается, когда решены все расхождения: незакрытая сверка
    # с частью решений — рабочее состояние, а не ошибка.
    if all(item.get("resolution") for item in discrepancies):
        invoice.resolved_at = clock.now()
        reconciliation["resolvedAt"] = invoice.resolved_at.isoformat()

    invoice.reconciliation = reconciliation
    invoice.save()

    _apply_resolution(invoice, discrepancies[index], actor)

    audit.record(
        entity_type=AuditEntityType.RECONCILIATION,
        entity_id=invoice.pk,
        action="discrepancy_resolved",
        actor=actor,
        before=before,
        after=discrepancies[index],
        comment=comment,
        is_demo=invoice.is_demo,
    )
    return invoice


def _apply_resolution(
    invoice: VendorInvoice, discrepancy: dict[str, Any], actor: User
) -> None:
    """Последствие решения для заявки на оплату.

    Своя сумма и претензия означают спор с поставщиком — заявка помечается
    спорной. «Принять счёт поставщика» спора не создаёт: мы согласились.
    """
    from billing.models import Payable
    from billing.services import payables

    order_id = discrepancy.get("serviceOrderId")
    if not order_id or discrepancy.get("resolution") not in ("keep_ours", "claim"):
        return

    payable = Payable.objects.filter(service_orders=order_id).first()
    if payable is None:
        return
    payables.mark_disputed(
        payable=payable,
        reason=_("Расхождение в сверке счёта %(number)s") % {"number": invoice.number},
        actor=actor,
    )
