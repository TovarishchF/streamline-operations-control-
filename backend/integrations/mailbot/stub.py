"""Генератор входящих писем `[ТЗ 3.2.2]` (`INTEGRATIONS.md § 3.3`).

Заглушка не выдумывает переписку из воздуха: письма составляются
по **настоящим** заявкам стенда, которые ждут ответа поставщика. Иначе
входящие не связывались бы с заявками, и кнопка «Применить» на экране
проверяла бы пустоту.

Три исхода, как описано в `INTEGRATIONS.md § 3.3`: подтверждение, отказ,
письмо с расхождением, которое разбор не опознаёт и отправляет в ручную
очередь. Исход выбирается детерминированно по идентификатору заявки:
стенд, показывающий разные ответы при каждом обновлении страницы,
разбирать нельзя.

Данные заглушки получают происхождение `synthetic` (`CLAUDE.md § 4`).
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from core import clock
from integrations.base import Exchange
from integrations.mailbot.base import IncomingMail

if TYPE_CHECKING:
    from orders.models import ServiceOrder

# Доли исходов. Сумма меньше единицы: часть заявок ответа не получает —
# именно за ними диспетчер и следит.
CONFIRM_SHARE = 55
REJECT_SHARE = 20
UNCLEAR_SHARE = 10

REJECT_REASONS = (
    "нет свободной техники на запрошенное время",
    "аэропорт не входит в зону обслуживания",
    "объём превышает суточный лимит",
)


def _bucket(order_id: str) -> int:
    """Число 0..99, устойчивое к перезапускам."""
    digest = hashlib.sha256(order_id.encode()).hexdigest()
    return int(digest[:4], 16) % 100


class Provider:
    """Заглушка разбора входящей почты."""

    code = "MAILBOT"

    def fetch(self, limit: int) -> tuple[list[IncomingMail], Exchange]:
        from orders.models import ServiceOrder, ServiceOrderStatus

        pending = (
            ServiceOrder.objects.filter(
                status=ServiceOrderStatus.ORDERED, vendor__isnull=False
            )
            .exclude(inbox_messages__isnull=False)
            .select_related("vendor", "service", "flight")
            .order_by("ordered_at")[:limit]
        )

        mails = [mail for order in pending if (mail := self._mail_for(order)) is not None]

        return mails, Exchange(
            operation="fetch",
            endpoint="stub://mailbot",
            response_body=f"{len(mails)} писем",
            response_bytes=sum(len(mail.body) for mail in mails),
        )

    def _mail_for(self, order: ServiceOrder) -> IncomingMail | None:
        bucket = _bucket(order.pk)
        vendor = order.vendor
        sender = f"ops@{_domain_for(vendor.name if vendor else 'vendor')}"
        reference = f"{order.flight.number} / {order.service.code}"

        if bucket < CONFIRM_SHARE:
            subject = f"Re: Заявка {order.pk} — подтверждение"
            body = (
                f"Здравствуйте!\n\nПодтверждаем заявку {order.pk} ({reference}).\n"
                f"Работы будут выполнены в запрошенное время.\n\nС уважением,\n"
                f"{vendor.name if vendor else ''}"
            )
        elif bucket < CONFIRM_SHARE + REJECT_SHARE:
            reason = REJECT_REASONS[bucket % len(REJECT_REASONS)]
            subject = f"Re: Заявка {order.pk} — отказ"
            body = (
                f"Здравствуйте!\n\nК сожалению, вынуждены отказать по заявке {order.pk} "
                f"({reference}): {reason}.\n\nС уважением,\n"
                f"{vendor.name if vendor else ''}"
            )
        elif bucket < CONFIRM_SHARE + REJECT_SHARE + UNCLEAR_SHARE:
            # Номера заявки в письме нет — разбор его не опознает, и оно
            # уйдёт в ручную очередь. Это штатный сценарий.
            subject = "Уточнение по обслуживанию"
            body = (
                f"Добрый день! По рейсу {order.flight.number} нужно уточнить время подачи. "
                "Перезвоните, пожалуйста."
            )
        else:
            return None

        return IncomingMail(
            external_id=f"stub-{order.pk}",
            sender=sender,
            subject=subject,
            body=body,
            received_at=clock.now(),
        )


def _domain_for(name: str) -> str:
    """Почтовый домен вымышленного поставщика.

    Наименования поставщиков на стенде вымышлены (`CLAUDE.md § 4`), домен
    собирается из них же и заканчивается на `.test` — зона, которая
    по RFC 2606 никому не принадлежит и никогда не будет настоящей.
    """
    letters = "".join(char for char in name.lower() if char.isalnum())[:16]
    return f"{letters or 'vendor'}.test"
