"""Общее для адаптеров разбора входящей почты `[ТЗ 3.2.2]`.

`INTEGRATIONS.md § 3.3`. Адаптер отвечает только за то, чтобы принести
письма. Что с ними делать — распознавать номер заявки, предлагать переход —
решает сервисный слой (`comms.services.inbox`): правила разбора одни
и те же независимо от того, откуда письмо взялось, и дублировать их
в каждом адаптере значило бы получить два разных разбора.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True)
class IncomingMail:
    """Письмо, как его принёс источник, без разбора."""

    # Идентификатор у источника. По нему повторная выборка не заводит
    # второе входящее: задачи обязаны быть идемпотентными
    # (`BACKEND.md § 5`).
    external_id: str
    sender: str
    subject: str
    body: str
    received_at: datetime


class MailbotProvider(Protocol):
    code: str

    def fetch(self, limit: int) -> tuple[list[IncomingMail], object]: ...
