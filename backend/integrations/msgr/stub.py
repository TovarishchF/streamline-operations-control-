"""Заглушка корпоративного мессенджера `[ТЗ 3.5.1]` (`INTEGRATIONS.md § 3.2`).

Наличие Bot API у MAX заказчиком не подтверждено (`G-04`). До подтверждения
канал считается неподтверждённым, и заглушка не изображает работающий
мессенджер: сообщение складывается в исходящие с каналом `messenger`
и остаётся видимым на экране, но наружу не уходит.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from integrations.base import Exchange
from integrations.channels import Delivery

if TYPE_CHECKING:
    from integrations.channels import Message


class Provider:
    """Заглушка мессенджера."""

    code = "MSGR"

    def send(self, message: Message) -> tuple[Delivery, Exchange]:
        chats = ", ".join(recipient.address for recipient in message.to)
        return (
            Delivery(delivered=False, detail="Режим stub: сообщение в мессенджер не отправлено"),
            Exchange(
                operation="send",
                endpoint="stub://msgr",
                request_body=f"Chats: {chats}\n{message.subject}",
                response_body='{"ok": true, "stub": true}',
            ),
        )
