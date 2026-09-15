"""Исходящая почта через SMTP `[ТЗ 3.5.2]` (`INTEGRATIONS.md § 3.1`).

Письмо собирается тем же сборщиком, что и `.eml` для выгрузки
(`comms.services.eml`): выгруженный файл обязан быть тем же письмом,
которое получил адресат, иначе разбирать спор с поставщиком по нему
нельзя.

Успешная отправка означает, что письмо принял **наш** сервер исходящей
почты, а не что его прочитали. Поэтому возвращается «отправлено», а не
«доставлено»: подтверждение доставки даёт только DSN, и пока его нет,
утверждать доставку нельзя.
"""

from __future__ import annotations

import smtplib
from typing import TYPE_CHECKING

from django.conf import settings

from integrations.base import Exchange
from integrations.channels import ChannelError, Delivery

if TYPE_CHECKING:
    from integrations.channels import Message

TIMEOUT_SECONDS = 30


class Provider:
    """Боевой адаптер SMTP."""

    code = "SMTP"

    def send(self, message: Message) -> tuple[Delivery, Exchange]:
        from comms.services.eml import build_eml

        sender = str(settings.SMTP_FROM)
        addresses = [recipient.address for recipient in message.to if recipient.address]
        if not addresses:
            raise ChannelError("у сообщения нет ни одного адреса получателя")

        payload = build_eml(message, sender=sender)

        try:
            with smtplib.SMTP(
                str(settings.SMTP_HOST), int(settings.SMTP_PORT), timeout=TIMEOUT_SECONDS
            ) as client:
                if settings.SMTP_USE_TLS:
                    client.starttls()
                if settings.SMTP_USER:
                    client.login(str(settings.SMTP_USER), str(settings.SMTP_PASSWORD))
                client.sendmail(sender, addresses, payload)
        except (OSError, smtplib.SMTPException) as error:
            # Отказ канала — повод повторить, а не потерять сообщение.
            raise ChannelError(f"{type(error).__name__}: {error}") from error

        return (
            Delivery(delivered=False, detail="Принято сервером исходящей почты"),
            Exchange(
                operation="send",
                endpoint=f"smtp://{settings.SMTP_HOST}:{settings.SMTP_PORT}",
                request_body=f"To: {', '.join(addresses)}\nSubject: {message.subject}",
                response_body="250 OK",
                http_status=250,
                response_bytes=len(payload),
            ),
        )
