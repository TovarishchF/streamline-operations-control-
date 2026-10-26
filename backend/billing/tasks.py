"""Фоновые задачи биллинга `[ТЗ 3.4]` (`BACKEND.md § 5`).

Обе задачи идемпотентны: уведомления несут ключ идемпотентности, статус
счёта выводится из платежей и срока, а не переключается вслепую.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from celery import shared_task

from billing.models import Invoice, Payable, PayableStatus
from billing.services import margin as margin_service
from billing.services import payments
from comms.services import notifications
from core import clock
from core.exceptions import DomainError

if TYPE_CHECKING:
    from accounts.models import User

logger = logging.getLogger(__name__)


def _staff(organization_id: str, roles: tuple[str, ...]) -> list[User]:
    from accounts.models import User as UserModel

    return list(
        UserModel.objects.filter(organization_id=organization_id, role__in=roles, is_active=True)
    )


@shared_task(name="billing.check_margin")  # type: ignore[misc]
def check_margin(flight_id: str) -> bool:
    """Предупреждение о марже ниже порога `[ТЗ 3.4.3]` (`SPEC.md § 7.4`).

    Одно уведомление на рейс: о том, что маржа рейса низкая, повторять
    при каждой правке заявки — значит приучить не читать колокольчик.
    В карточке рейса предупреждение видно всегда, пока маржа ниже порога.
    """
    from accounts.models import Role
    from flights.models import Flight

    flight = Flight.objects.filter(pk=flight_id).select_related("client").first()
    if flight is None:
        return False
    try:
        result = margin_service.margin_for(flight, "mixed")
    except DomainError as error:
        # Нет курса — маржу не посчитать; в карточке рейса это видно,
        # а фоновая задача не место для отказа.
        logger.warning("маржа рейса %s не посчитана: %s", flight.number, error)
        return False
    if not result.is_below_threshold:
        return False

    percent = f"{result.margin_percent} %" if result.margin_percent is not None else "—"
    notifications.notify_many(
        users=_staff(flight.organization_id, (Role.DISPATCHER, Role.MANAGER, Role.FINANCE)),
        kind="low_margin",
        title=f"Рейс {flight.number}: маржа {percent} ниже порога {result.threshold_percent} %",
        body=f"Выручка {result.revenue}, расход {result.cost}",
        link=f"/flights/{flight.pk}/finance",
        dedupe_key=f"low_margin:{flight.pk}",
    )
    return True


@shared_task(name="billing.check_overdue")  # type: ignore[misc]
def check_overdue() -> int:
    """Просроченная дебиторка и кредиторка `[ТЗ 3.4.2]`.

    Статус счёта выводится заново (ADR-019): срок прошёл, а оплачено
    не всё — «просрочен». Финансистам — по уведомлению на каждый
    просроченный счёт клиента и каждую просроченную заявку на оплату.
    """
    from accounts.models import Role

    current = clock.now()
    flagged = 0

    for invoice in Invoice.objects.filter(
        status__in=payments.PAYABLE_STATUSES, due_date__lt=current
    ).select_related("client", "flight"):
        payments.refresh_status(invoice, at=current)
        if invoice.status != "overdue":
            continue
        notifications.notify_many(
            users=_staff(invoice.flight.organization_id, (Role.FINANCE,)),
            kind="payment_overdue",
            title=f"Счёт {invoice.number} клиенту {invoice.client.name} просрочен",
            body=f"Срок оплаты {invoice.due_date:%d.%m.%Y}",
            link=f"/billing/invoices/{invoice.pk}",
            dedupe_key=f"invoice_overdue:{invoice.pk}",
        )
        flagged += 1

    for payable in Payable.objects.filter(due_date__lt=current).exclude(
        status__in=(PayableStatus.PAID, PayableStatus.CANCELLED)
    ).select_related("vendor"):
        notifications.notify_many(
            users=_staff(payable.vendor.organization_id, (Role.FINANCE,)),
            kind="payment_overdue",
            title=f"Оплата поставщику {payable.vendor.name} просрочена: {payable.number}",
            body=f"Срок оплаты {payable.due_date:%d.%m.%Y}",
            link="/billing/payables",
            dedupe_key=f"payable_overdue:{payable.pk}",
        )
        flagged += 1

    return flagged
