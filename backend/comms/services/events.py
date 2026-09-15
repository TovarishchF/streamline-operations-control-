"""Сообщения и уведомления по доменным событиям `[ТЗ 3.5.1, 3.5.2]`.

Собрано в одном месте намеренно. Заказ услуги не должен знать, какой
шаблон письма уходит поставщику и кого уведомлять о подтверждении: он
сообщает, что произошло, а решение — здесь. Иначе правка текста письма
означала бы правку доменного сервиса.

Ни одно из этих действий не отменяет основную операцию: если получателя
нет или шаблон не заведён, заявка всё равно создаётся. Письмо — следствие
события, а не его условие.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from django.db import transaction

from comms.services import context, notifications, outbox
from comms.services.templates import TemplateNotFound

if TYPE_CHECKING:
    from accounts.models import User
    from billing.models import Invoice, Quote
    from counterparties.models import Client, Vendor
    from orders.models import ServiceOrder

logger = logging.getLogger(__name__)


def _recipients(owner: Vendor | Client | None) -> list[dict[str, str]]:
    """Контакты контрагента для переписки.

    Язык берётся из контакта: письмо поставщику уходит на его языке,
    а не на языке отправителя (`DOMAIN.md § 9`).
    """
    if owner is None:
        return []
    return [
        {"name": contact.name, "address": contact.email, "locale": contact.locale}
        for contact in owner.contacts.all()
        if contact.email
    ]


def _enqueue(code: str, **kwargs: Any) -> None:
    """Ставит письмо в очередь после фиксации транзакции.

    `CLAUDE.md § 3` п. 13: письмо о заявке, которой не случилось из-за
    отката, отозвать нельзя.
    """

    def send() -> None:
        try:
            outbox.enqueue_from_template(code=code, **kwargs)
        except TemplateNotFound:
            # Отсутствие шаблона — повод завести шаблон, а не повод
            # отменить операцию, которая уже состоялась.
            logger.warning("шаблон %s не заведён, письмо не отправлено", code)

    transaction.on_commit(send)


# ─────────────────────────── Заявки на услуги ───────────────────────────


def order_placed(order: ServiceOrder) -> None:
    """Заявка ушла поставщику `[ТЗ 3.2.2]`."""
    to = _recipients(order.vendor)
    if not to:
        logger.info("у поставщика заявки %s нет контактов для переписки", order.pk)
        return

    _enqueue(
        "order_placed",
        to=to,
        data=_order_data(order),
        related=("service_order", order.pk),
    )


def order_cancelled(order: ServiceOrder, *, reason: str) -> None:
    to = _recipients(order.vendor)
    if not to:
        return
    data = _order_data(order)
    data["change"] = {"reason": reason}
    _enqueue("order_cancelled", to=to, data=data, related=("service_order", order.pk))


def order_answered(order: ServiceOrder, *, confirmed: bool, actor: User | None) -> None:
    """Поставщик ответил `[ТЗ 3.5.1]`."""
    notifications.notify_many(
        users=_dispatchers(order.flight.organization_id, exclude=actor),
        kind="service_confirmed" if confirmed else "service_rejected",
        title=(
            f"{order.service.name_ru}: "
            f"{'подтверждена' if confirmed else 'отклонена'} "
            f"по рейсу {order.flight.number}"
        ),
        body=order.rejection_reason if not confirmed else "",
        link=f"/flights/{order.flight_id}/services",
    )


def order_sla_breached(order: ServiceOrder) -> None:
    notifications.notify_many(
        users=_dispatchers(order.flight.organization_id, exclude=None),
        kind="sla_breach",
        title=f"Просрочено подтверждение: {order.service.name_ru}, рейс {order.flight.number}",
        link=f"/flights/{order.flight_id}/services",
    )


# ─────────────────────────── Документы ───────────────────────────


def document_issued(document: Quote | Invoice, *, kind: str) -> None:
    """Котировка или счёт выставлены клиенту `[ТЗ 3.5.2]`."""
    to = _recipients(document.client)
    if not to:
        logger.info("у клиента документа %s нет контактов для переписки", document.pk)
        return

    _enqueue(
        "invoice_issued" if kind == "invoice" else "quote_issued",
        to=to,
        data={
            "document": context.document_data(document),
            "flight": context.flight_data(document.flight),
            "client": {"name": document.client.name},
            "operator": context.operator_data(),
        },
        related=(kind, document.pk),
    )


# ─────────────────────────── Рейсы ───────────────────────────


def flight_status_changed(flight: Any, *, previous: str, actor: User | None) -> None:
    """Смена статуса рейса `[ТЗ 3.5.1]`."""
    notifications.notify_many(
        users=_dispatchers(flight.organization_id, exclude=actor),
        kind="flight_status",
        title=f"Рейс {flight.number}: {flight.get_status_display()}",
        body=f"Было: {previous}",
        link=f"/flights/{flight.pk}",
    )


# ─────────────────────────── Общее ───────────────────────────


def _order_data(order: ServiceOrder) -> dict[str, Any]:
    return {
        "order": context.order_data(order),
        "service": {"name": order.service.name_ru, "code": order.service.code},
        "flight": context.flight_data(order.flight),
        "vendor": {"name": order.vendor.name} if order.vendor else {},
        "operator": context.operator_data(),
    }


def _dispatchers(organization_id: str, *, exclude: User | None) -> list[User]:
    """Кому адресовать событие по рейсу.

    У рейса нет закреплённого диспетчера, поэтому уведомление уходит всем
    диспетчерам и руководителям организации — так и сформулировано
    в `SPEC.md § 8.1`. Настройка подписки по роли и по пользователю
    появится там же, где появится её экран; до тех пор адресат
    определяется ролью, а не догадкой.

    Автор действия исключается: сообщать человеку о том, что он сам
    только что сделал, — способ приучить не читать колокольчик.
    """
    from accounts.models import Role
    from accounts.models import User as UserModel

    queryset = UserModel.objects.filter(
        organization_id=organization_id,
        role__in=(Role.DISPATCHER, Role.MANAGER),
        is_active=True,
    )
    if exclude is not None:
        queryset = queryset.exclude(pk=exclude.pk)
    return list(queryset)
