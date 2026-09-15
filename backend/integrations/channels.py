"""Общее для адаптеров каналов сообщений `[ТЗ 3.5.1, 3.5.2]`.

`INTEGRATIONS.md § 3.1, 3.2`: адаптер канала универсален —
`send(message)`. Смена мессенджера не затрагивает доменный код, поэтому
подпись одна на почту и на мессенджер, а различия остаются внутри.

Что вернул канал, описывает `Delivery`: отправлено или доставлено и что
сказал получатель. Различие существенное: SMTP подтверждает приём своим
сервером, а не прочтение письма, и называть это «доставлено» было бы
неправдой.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

# Порядок повторов: задержка растёт, число попыток ограничено
# (`BACKEND.md § 5`). Шестая попытка через сутки после первой смысла
# не имеет: если канал не отвечает сутки, разбираться нужно человеку.
RETRY_DELAYS_SECONDS = (60, 300, 1_800)
MAX_ATTEMPTS = len(RETRY_DELAYS_SECONDS) + 1


@dataclass(frozen=True)
class Recipient:
    name: str
    address: str
    locale: str = "ru"


@dataclass(frozen=True)
class Message:
    """Сообщение, готовое к отправке. Собрано до вызова канала."""

    subject: str
    body: str
    to: list[Recipient]
    # Пары (имя файла, содержимое). Вложения читаются из хранилища
    # до вызова канала: адаптер не должен знать про S3.
    attachments: list[tuple[str, bytes]] = field(default_factory=list)


@dataclass(frozen=True)
class Delivery:
    """Результат обращения к каналу."""

    delivered: bool
    detail: str = ""


class ChannelProvider(Protocol):
    code: str

    def send(self, message: Message) -> tuple[Delivery, object]: ...


class ChannelError(Exception):
    """Канал не принял сообщение. Отправка будет повторена."""
