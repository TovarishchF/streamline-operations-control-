"""Внутренние уведомления `[ТЗ 3.5.1]` (`SPEC.md § 8.1`).

Уведомление адресное: у него есть пользователь. Рассылка «всем диспетчерам»
раскрывается в записи на каждого — иначе прочитанность пришлось бы хранить
отдельной таблицей, а колокольчик считал бы непрочитанные подзапросом.

Уведомление ведёт на экран системы, где событие можно разобрать. Ссылка
хранится относительной: адрес стенда и адрес боевой установки разные,
а маршрут один и тот же.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from comms.models import Notification, NotificationSeverity
from core import clock
from core.demo_marking import is_demo as demo_mode

if TYPE_CHECKING:
    from collections.abc import Iterable

    from accounts.models import User

# Какой тревожности событие. Задано здесь, а не в месте создания:
# иначе одно и то же событие оказывалось бы то предупреждением,
# то критичным, в зависимости от того, кто его завёл.
SEVERITY_BY_KIND = {
    "flight_status": NotificationSeverity.INFO,
    "service_confirmed": NotificationSeverity.INFO,
    "service_rejected": NotificationSeverity.WARNING,
    "deadline": NotificationSeverity.WARNING,
    "sla_breach": NotificationSeverity.CRITICAL,
    "contract_expiry": NotificationSeverity.WARNING,
    "payment_overdue": NotificationSeverity.CRITICAL,
    "low_margin": NotificationSeverity.WARNING,
}


def notify(
    *,
    user: User,
    kind: str,
    title: str,
    body: str = "",
    link: str = "",
) -> Notification:
    """Заводит уведомление одному пользователю."""
    return Notification.objects.create(
        user=user,
        kind=kind,
        severity=SEVERITY_BY_KIND.get(kind, NotificationSeverity.INFO),
        title=title[:255],
        body=body,
        link=link[:255],
        is_demo=demo_mode(),
    )


def notify_many(
    *,
    users: Iterable[User],
    kind: str,
    title: str,
    body: str = "",
    link: str = "",
) -> list[Notification]:
    """Одно событие — запись каждому адресату."""
    return [notify(user=user, kind=kind, title=title, body=body, link=link) for user in users]


def mark_read(*, notification: Notification) -> Notification:
    """Отметка прочтения. Повторная отметка время не переписывает."""
    if notification.read_at is None:
        notification.read_at = clock.now()
        notification.save(update_fields=["read_at", "updated_at", "version"])
    return notification


def unread_count(user: User) -> int:
    return Notification.objects.filter(user=user, read_at__isnull=True).count()
