"""Напоминания об истечении договоров `[ТЗ 3.3.3]` (`SPEC.md § 6.3`).

За 30, 15 и 7 дней (пороги — `Settings.contract_expiry_reminders`)
договор порождает уведомление сотрудникам и письмо поставщику. Повторно
одно и то же напоминание не создаётся: ключ идемпотентности
`contract_expiry:<договор>:<порог>` (`DOMAIN.md § 9`) защищён
ограничением уникальности в базе, а не только проверкой в коде.

Время — модельное (`core.clock`): перемотка на 25 дней вперёд даёт ровно
по одному напоминанию на каждый пройденный порог.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from django.db import transaction

from comms.models import Notification, OutboxMessage
from comms.services import context, notifications
from core import clock
from core.models import Settings
from counterparties.models import VendorContract

if TYPE_CHECKING:
    from accounts.models import User


def dedupe_key(contract: VendorContract, threshold: int) -> str:
    return f"contract_expiry:{contract.pk}:{threshold}"


def thresholds() -> list[int]:
    """Пороги по убыванию. Ноль и отрицательные значения бессмысленны."""
    raw = Settings.get_solo().contract_expiry_reminders or []
    return sorted({int(value) for value in raw if int(value) > 0}, reverse=True)


def remind_expiring() -> int:
    """Заводит напоминания по всем пройденным порогам. Возвращает число новых."""
    levels = thresholds()
    if not levels:
        return 0

    current = clock.now()
    contracts = VendorContract.objects.filter(
        terminated_at__isnull=True,
        valid_to__gt=current,
        valid_to__lte=current + timedelta(days=levels[0]),
    ).select_related("vendor")

    created = 0
    for contract in contracts:
        left = contract.valid_to - current
        for threshold in levels:
            if left > timedelta(days=threshold):
                continue
            key = dedupe_key(contract, threshold)
            if (
                Notification.objects.filter(dedupe_key=key).exists()
                or OutboxMessage.objects.filter(dedupe_key=key).exists()
            ):
                continue
            with transaction.atomic():
                _remind(contract, threshold=threshold, key=key)
            created += 1
    return created


def _remind(contract: VendorContract, *, threshold: int, key: str) -> None:
    """Уведомление сотрудникам и письмо поставщику по одному порогу."""
    from comms.services import events as comms_events

    notifications.notify_many(
        users=_staff(contract.vendor.organization_id),
        kind="contract_expiry",
        title=(
            f"Договор {contract.number} с {contract.vendor.name} истекает "
            f"{context.utc(contract.valid_to)} UTC"
        ),
        body=f"Осталось не больше {threshold} дн.",
        link="/contracts",
        dedupe_key=key,
    )
    comms_events.contract_expiring(contract, dedupe_key=key)


def _staff(organization_id: str) -> list[User]:
    """Кто ведёт договоры: финансисты, руководители и диспетчеры.

    Диспетчер заказывает услуги по договору и узнать об истечении
    должен до того, как заказ будет заблокирован проверкой договора.
    """
    from accounts.models import Role
    from accounts.models import User as UserModel

    return list(
        UserModel.objects.filter(
            organization_id=organization_id,
            role__in=(Role.FINANCE, Role.MANAGER, Role.DISPATCHER),
            is_active=True,
        )
    )
