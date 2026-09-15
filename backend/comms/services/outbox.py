"""Очередь исходящих сообщений `[ТЗ 3.5.2]` (`SPEC.md § 8.2`).

Постановка в очередь и отправка разделены намеренно. Заявка поставщику
ставится в очередь в той же транзакции, что и сама заявка, а уходит
наружу уже после фиксации (`CLAUDE.md § 3` п. 13): письмо о заявке,
которой не случилось из-за отката, отозвать нельзя.

Повторы с растущей задержкой (`BACKEND.md § 5`). После исчерпания попыток
сообщение остаётся в состоянии «ошибка» с текстом причины и ждёт человека:
молча выбрасывать неотправленную заявку поставщику нельзя.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any, ClassVar

from django.db import transaction
from django.utils.translation import gettext as _

from comms.models import MessageChannel, MessageTemplate, OutboxMessage, OutboxStatus
from comms.services import templates as template_service
from core import clock
from core.demo_marking import DEMO_SUBJECT_PREFIX
from core.demo_marking import is_demo as demo_mode
from core.exceptions import DomainError
from core.services import storage
from integrations.base import get_provider, mode_for, record_exchange
from integrations.channels import (
    MAX_ATTEMPTS,
    RETRY_DELAYS_SECONDS,
    ChannelError,
    Message,
    Recipient,
)

if TYPE_CHECKING:
    from django.db.models import QuerySet

    from accounts.models import User

# Код подключения на канал. Портал внешнего подключения не имеет:
# сообщение просто появляется в портале получателя.
CHANNEL_CODES: dict[str, str] = {
    MessageChannel.EMAIL: "SMTP",
    MessageChannel.MESSENGER: "MSGR",
}


class MessageNotRetryable(DomainError):
    """Повтор отправленного сообщения."""

    code = "MESSAGE_ALREADY_SENT"
    http_status: ClassVar[int] = 409


def enqueue(
    *,
    channel: str,
    to: list[dict[str, str]],
    subject: str,
    body: str,
    template_code: str = "",
    related: tuple[str, str] | None = None,
    attachment_ids: list[str] | None = None,
    is_demo: bool = False,
) -> OutboxMessage:
    """Ставит собранное сообщение в очередь.

    Тема на стенде получает префикс `[DEMO]` (`SPEC.md § 8.6`): письмо,
    ушедшее с демонстрационного стенда, должно быть опознаваемо получателем,
    а не только на экране системы.
    """
    prefix = DEMO_SUBJECT_PREFIX if demo_mode() else ""

    message = OutboxMessage.objects.create(
        channel=channel,
        channel_mode=mode_for(CHANNEL_CODES[channel]) if channel in CHANNEL_CODES else "",
        to=to,
        template_code=template_code,
        subject=f"{prefix}{subject}"[:255],
        body=body,
        related_entity_type=related[0] if related else "",
        related_entity_id=related[1] if related else "",
        status=OutboxStatus.QUEUED,
        is_demo=is_demo or demo_mode(),
    )

    if attachment_ids:
        from core.services import attachments as attachment_service

        attachment_service.attach(attachment_ids=attachment_ids, owner=message)

    return message


def enqueue_from_template(
    *,
    code: str,
    to: list[dict[str, str]],
    data: dict[str, Any],
    related: tuple[str, str] | None = None,
    attachment_ids: list[str] | None = None,
) -> OutboxMessage:
    """Собирает сообщение по шаблону и ставит в очередь.

    Язык выбирается по локали первого получателя (`SPEC.md § 8.2`):
    письмо одно, а язык у него может быть только один. Получателям
    с разными языками отправляются разные сообщения — вызывающий код
    группирует их сам.
    """
    try:
        template = MessageTemplate.objects.get(code=code)
    except MessageTemplate.DoesNotExist as error:
        raise template_service.TemplateNotFound(
            _("Шаблон %(code)s не найден") % {"code": code}, {"code": code}
        ) from error

    locale = str(to[0].get("locale", "ru")) if to else "ru"
    rendered = template_service.render_template(template, locale=locale, data=data)

    return enqueue(
        channel=template.channel,
        to=to,
        subject=rendered.subject,
        body=rendered.body,
        template_code=template.code,
        related=related,
        attachment_ids=attachment_ids,
    )


def enqueue_on_commit(**kwargs: Any) -> None:
    """Постановка в очередь после фиксации транзакции.

    `CLAUDE.md § 3` п. 13: побочные эффекты, уходящие наружу, выполняются
    только когда изменение действительно сохранено.
    """
    transaction.on_commit(lambda: enqueue(**kwargs))


def due_messages(limit: int = 50) -> QuerySet[OutboxMessage]:
    """Сообщения, которым пора уходить.

    Пустой срок следующей попытки означает «сейчас»: так выглядит
    сообщение, только что поставленное в очередь.
    """
    from django.db.models import Q

    current = clock.now()
    return OutboxMessage.objects.filter(
        Q(status=OutboxStatus.QUEUED)
        & (Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=current))
    ).order_by("created_at")[:limit]


def _build_payload(message: OutboxMessage) -> Message:
    recipients = [
        Recipient(
            name=str(item.get("name", "")),
            address=str(item.get("address", "")),
            locale=str(item.get("locale", "ru")),
        )
        for item in message.to
    ]

    files: list[tuple[str, bytes]] = []
    for attachment in message.attachments.all():
        if attachment.uploaded_at is None:
            # Незавершённая загрузка не прикладывается: пустой файл
            # в письме поставщику хуже, чем письмо без файла.
            continue
        files.append((attachment.file_name, storage.get_bytes(attachment.storage_key)))

    return Message(
        subject=message.subject, body=message.body, to=recipients, attachments=files
    )


def _store_eml(message: OutboxMessage, payload: Message) -> str:
    """Кладёт письмо в хранилище и возвращает ключ.

    Файл сохраняется в обоих режимах, а не только в заглушке: это ровно
    то письмо, которое ушло или ушло бы, и именно по нему разбирают спор
    с поставщиком. В боевом режиме такая копия нужна не меньше.
    """
    from django.conf import settings

    from comms.services.eml import build_eml

    data = build_eml(payload, sender=str(settings.SMTP_FROM))
    key = f"messages/{message.created_at:%Y/%m}/{message.pk}.eml"
    storage.put_bytes(key=key, data=data, mime_type="message/rfc822")
    return key


def eml_url(message: OutboxMessage) -> str | None:
    """Подписанная ссылка на `.eml`. `None`, если файла нет."""
    if not message.eml_key:
        return None
    return storage.presign_get(key=message.eml_key, file_name=f"{message.pk}.eml")


def send(message: OutboxMessage) -> OutboxMessage:
    """Одна попытка отправки.

    Отказ канала не теряется: он записывается в сообщение и в журнал
    обменов, а сообщение либо ждёт следующей попытки, либо переходит
    в «ошибка», если попытки исчерпаны.
    """
    payload = _build_payload(message)
    message.attempts += 1

    if message.channel == MessageChannel.PORTAL:
        # Портал — не внешнее подключение: сообщение уже доступно
        # получателю тем, что оно есть в системе.
        message.status = OutboxStatus.DELIVERED
        message.sent_at = clock.now()
        message.last_error = ""
        message.next_attempt_at = None
        message.save()
        return message

    code = CHANNEL_CODES[message.channel]
    message.channel_mode = mode_for(code)

    try:
        provider = get_provider(code)
        delivery = record_exchange(
            code,
            lambda: provider.send(payload),
            is_demo=message.is_demo,
        )
    except Exception as error:
        return _fail(message, error)

    if message.channel == MessageChannel.EMAIL:
        message.eml_key = _store_eml(message, payload)

    message.status = OutboxStatus.DELIVERED if delivery.delivered else OutboxStatus.SENT
    message.sent_at = clock.now()
    message.last_error = ""
    message.next_attempt_at = None
    message.save()
    return message


def _fail(message: OutboxMessage, error: Exception) -> OutboxMessage:
    message.last_error = f"{type(error).__name__}: {error}"[:2000]

    if message.attempts >= MAX_ATTEMPTS:
        # Попытки исчерпаны — сообщение ждёт человека, а не исчезает.
        message.status = OutboxStatus.FAILED
        message.next_attempt_at = None
    else:
        delay = RETRY_DELAYS_SECONDS[min(message.attempts - 1, len(RETRY_DELAYS_SECONDS) - 1)]
        message.status = OutboxStatus.QUEUED
        message.next_attempt_at = clock.now() + timedelta(seconds=delay)

    message.save()
    return message


def retry(*, message: OutboxMessage, actor: User | None = None) -> OutboxMessage:
    """Повторная отправка по кнопке `[ТЗ 3.5.2]`.

    Повторяется только то, что не ушло. Отправленное повторяют не кнопкой
    «Повторить», а новым сообщением: второй экземпляр письма поставщику
    читается как второй заказ.
    """
    if message.status in (OutboxStatus.SENT, OutboxStatus.DELIVERED):
        raise MessageNotRetryable(
            _("Сообщение уже отправлено, повтор создал бы второй экземпляр"),
            {"status": message.status},
        )

    # Счётчик попыток сбрасывается: человек нажал кнопку осознанно,
    # и запрет по числу автоматических попыток к нему не относится.
    message.attempts = 0
    message.status = OutboxStatus.QUEUED
    message.next_attempt_at = None
    message.save()

    from audit import services as audit

    if actor is not None:
        audit.record(
            entity_type="outbox_message",
            entity_id=message.pk,
            action="retry_requested",
            actor=actor,
        )

    return send(message)


def send_due(limit: int = 50) -> int:
    """Отправляет всё, чему пора. Возвращает число обработанных сообщений."""
    processed = 0
    for message in list(due_messages(limit)):
        # Ошибка одного сообщения не должна останавливать очередь.
        try:
            send(message)
        except ChannelError:
            pass
        processed += 1
    return processed
