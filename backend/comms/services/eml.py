"""Сборка письма в формате `.eml` `[ТЗ 3.5.2]` (`INTEGRATIONS.md § 3.1`).

Один сборщик и на отправку, и на выгрузку. Выгруженный со стенда файл
обязан быть тем же письмом, которое ушло бы наружу, — иначе по нему нельзя
разбирать спор с поставщиком, а именно для этого выгрузка и нужна.

Кириллица кодируется по RFC 2047 в заголовках и base64 в теле: письмо
с темой в неверной кодировке выглядит у получателя как мусор, и это
первое, что ломается в самописной сборке.
"""

from __future__ import annotations

from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from integrations.channels import Message


def build_message(message: Message, *, sender: str) -> EmailMessage:
    """Собирает `EmailMessage` со всеми вложениями."""
    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = ", ".join(
        formataddr((recipient.name, recipient.address)) for recipient in message.to
    )
    mail["Subject"] = message.subject
    mail["Date"] = formatdate(localtime=False)
    mail["Message-ID"] = make_msgid(domain="soc.local")
    mail.set_content(message.body)

    for file_name, payload in message.attachments:
        mail.add_attachment(
            payload,
            maintype="application",
            subtype="octet-stream",
            filename=file_name,
        )

    return mail


def build_eml(message: Message, *, sender: str) -> bytes:
    """Письмо целиком, байтами, готовое к отправке или сохранению."""
    return bytes(build_message(message, sender=sender).as_bytes())
