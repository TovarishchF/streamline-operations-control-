"""Заглушка исходящей почты `[ТЗ 3.5.2]` (`INTEGRATIONS.md § 3.1`).

Внешнего вызова нет. Сообщение считается отправленным, и это записывается
в журнал обменов с режимом `stub`: заглушка не изображает работу почтового
сервера (`CLAUDE.md § 4`).

Само письмо при этом собирается **настоящим** — тем же `.eml`, что ушёл бы
наружу. Собрать его иначе значило бы проверять на стенде не то, что уйдёт
в боевом режиме.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from integrations.base import Exchange
from integrations.channels import Delivery

if TYPE_CHECKING:
    from integrations.channels import Message


class Provider:
    """Заглушка SMTP."""

    code = "SMTP"

    def send(self, message: Message) -> tuple[Delivery, Exchange]:
        addresses = ", ".join(recipient.address for recipient in message.to)
        return (
            # Отправлено, но не доставлено: доставку заглушка подтвердить
            # не может, и утверждать её было бы неправдой.
            Delivery(delivered=False, detail="Режим stub: письмо наружу не отправлено"),
            Exchange(
                operation="send",
                endpoint="stub://smtp",
                request_body=f"To: {addresses}\nSubject: {message.subject}",
                response_body="250 OK (stub)",
                http_status=250,
            ),
        )
