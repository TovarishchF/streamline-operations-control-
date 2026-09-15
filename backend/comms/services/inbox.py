"""Разбор входящих внешних событий `[ТЗ 3.2.2]` (`SPEC.md § 8.3`).

Правила разбора живут здесь, а не в адаптере: письмо может прийти
из почтового ящика, из портала поставщика или от демонстрационного
генератора, а разбирать их нужно одинаково.

Разбор **предлагает**, а не решает. Даже опознанное письмо не меняет
статус заявки само: `INTEGRATIONS.md § 3.3` прямо говорит, что полностью
автоматического разбора не будет, и цель — снять 60–70 % рутины.
Применяет предложение человек, и это записывается в аудит на его имя.

Нераспознанное письмо — штатный исход, а не сбой. Оно попадает в очередь
ручного разбора, и на экране это так и называется.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, ClassVar

from django.db import transaction
from django.utils.translation import gettext as _

from audit import services as audit
from comms.models import InboxMessage, MessageChannel
from core import clock
from core.exceptions import DomainError

if TYPE_CHECKING:
    from accounts.models import User
    from integrations.mailbot.base import IncomingMail
    from orders.models import ServiceOrder

# Идентификатор заявки в тексте письма. Префикс `ord_` задан `core.make_id`,
# и искать по нему надёжнее, чем по «номеру заявки» в свободной форме.
ORDER_ID = re.compile(r"\bord_[0-9A-Za-z]{20,32}\b")

# Слова, по которым узнаётся намерение поставщика. Список намеренно
# короткий: широкий список ошибается чаще, а цена ошибки здесь — заявка,
# отменённая по слову «отказ» в подписи.
CONFIRM_WORDS = ("подтвержда", "подтверждаем", "confirm", "accepted")
REJECT_WORDS = ("отказ", "отклоня", "не сможем", "reject", "decline")


class InboxAlreadyApplied(DomainError):
    """Входящее уже применено к заявке."""

    code = "INBOX_ALREADY_APPLIED"
    http_status: ClassVar[int] = 409


class InboxNotRecognized(DomainError):
    code = "VALIDATION_ERROR"


def find_order(text: str) -> ServiceOrder | None:
    """Заявка, упомянутая в тексте."""
    from orders.models import ServiceOrder

    match = ORDER_ID.search(text)
    if match is None:
        return None
    return ServiceOrder.objects.filter(pk=match.group(0)).first()


def suggest_action(text: str) -> str:
    """Переход автомата, который предлагает разбор. Пусто — не понял.

    Отказ проверяется первым: письмо «подтвердить не сможем» содержит оба
    признака, и трактовать его как подтверждение было бы хуже всего.
    """
    lowered = text.lower()
    if any(word in lowered for word in REJECT_WORDS):
        return "reject"
    if any(word in lowered for word in CONFIRM_WORDS):
        return "confirm"
    return ""


def ingest(mail: IncomingMail, *, channel: str = MessageChannel.EMAIL) -> InboxMessage:
    """Заводит входящее и сразу его разбирает.

    Повторная выборка того же письма из ящика не создаёт второй записи:
    задачи обязаны быть идемпотентными (`BACKEND.md § 5`).
    """
    existing = InboxMessage.objects.filter(external_id=mail.external_id).first()
    if existing is not None:
        return existing

    text = f"{mail.subject}\n{mail.body}"
    order = find_order(text)
    action = suggest_action(text) if order is not None else ""

    from core.models import DataSource
    from integrations.base import mode_for
    from integrations.models import IntegrationMode

    live = mode_for("MAILBOT") == IntegrationMode.LIVE

    return InboxMessage.objects.create(
        channel=channel,
        sender=mail.sender,
        subject=mail.subject,
        body=mail.body,
        received_at=mail.received_at,
        # Опознанным считается письмо, в котором нашлись и заявка,
        # и понятное намерение. Заявка без намерения — это переписка,
        # и применять по ней нечего.
        recognized=bool(order is not None and action),
        service_order=order,
        suggested_action=action,
        external_id=mail.external_id,
        data_source=DataSource.LIVE if live else DataSource.SYNTHETIC,
    )


@transaction.atomic
def apply(
    *,
    message: InboxMessage,
    actor: User,
    service_order: ServiceOrder | None = None,
    transition: str = "",
) -> InboxMessage:
    """Применяет входящее к заявке `[ТЗ 3.2.2]`.

    Заявку и переход можно указать вручную: так разбирается письмо,
    которое автомат не опознал. Это и есть кнопка «Обработать вручную».
    """
    if message.applied_at is not None:
        raise InboxAlreadyApplied(
            _("Входящее уже применено"), {"appliedAt": message.applied_at.isoformat()}
        )

    order = service_order or message.service_order
    action = transition or message.suggested_action

    if order is None or not action:
        raise InboxNotRecognized(
            _("Укажите заявку и действие: разбор их не определил"),
            {
                "serviceOrderId": "" if order is None else order.pk,
                "transition": action,
            },
        )

    from orders.services import transitions as order_transitions

    order_transitions.apply_transition(
        order,
        action,
        actor=actor,
        comment=_("По входящему письму от %(sender)s") % {"sender": message.sender},
    )

    message.service_order = order
    message.suggested_action = action
    message.recognized = True
    message.applied_at = clock.now()
    message.applied_by = actor
    message.save()

    audit.record(
        entity_type="inbox_message",
        entity_id=message.pk,
        action="applied",
        actor=actor,
        after={"serviceOrderId": order.pk, "transition": action},
    )

    return message


def poll(limit: int = 50) -> int:
    """Забирает письма у источника и разбирает. Возвращает число новых."""
    from integrations.base import get_provider, record_exchange

    provider = get_provider("MAILBOT")
    mails = record_exchange("MAILBOT", lambda: provider.fetch(limit))

    created = 0
    for mail in mails:
        before = InboxMessage.objects.filter(external_id=mail.external_id).exists()
        ingest(mail)
        if not before:
            created += 1
    return created
