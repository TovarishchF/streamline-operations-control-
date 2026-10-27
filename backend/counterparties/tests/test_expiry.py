"""Напоминания об истечении договоров `[ТЗ 3.3.3]` (`SPEC.md § 6.3`).

Приёмка M6: сдвиг времени на 25 дней порождает ровно одно уведомление
на каждый порог по каждому контракту.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest
from freezegun import freeze_time

from accounts.models import Role
from comms.models import MessageChannel, MessageTemplate, Notification, OutboxMessage
from core.clock import now
from counterparties.models import Contact
from counterparties.services import expiry
from counterparties.tasks import check_expiry
from counterparties.tests.conftest import give_contract, make_vendor

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import Organization, User
    from counterparties.models import VendorContract

pytestmark = pytest.mark.django_db


@pytest.fixture
def template(db: None) -> MessageTemplate:
    return MessageTemplate.objects.create(
        code="contract_expiring",
        channel=MessageChannel.EMAIL,
        subject_ru="Контракт {{contract.number}} истекает {{contract.validTo}}",
        subject_en="Contract {{contract.number}} expires on {{contract.validTo}}",
        body_ru="Срок действия контракта {{contract.number}} истекает {{contract.validTo}}.",
        body_en="Contract {{contract.number}} expires on {{contract.validTo}}.",
    )


@pytest.fixture
def staff(make_user: Callable[..., User]) -> list[User]:
    return [make_user(Role.FINANCE, suffix="f"), make_user(Role.DISPATCHER, suffix="d")]


@pytest.fixture
def contracts(organization: Organization) -> list[VendorContract]:
    """Два договора, истекающих через 35 и 40 дней: оба пока вне порогов."""
    result = []
    for name, days in (("Хэндлинг Север", 35), ("Кейтеринг Юг", 40)):
        vendor = make_vendor(organization, name, specializations=["handling"], bases=[])
        Contact.objects.create(vendor=vendor, name="Иван Петров", email=f"{days}@example.test")
        result.append(give_contract(vendor, days_left=days))
    return result


def run_task(capture: Any) -> int:
    with capture(execute=True):
        created: int = check_expiry()
    return created


def test_contracts_beyond_the_first_threshold_are_quiet(
    contracts: list[VendorContract], staff: list[User], django_capture_on_commit_callbacks: Any
) -> None:
    assert run_task(django_capture_on_commit_callbacks) == 0
    assert not Notification.objects.exists()


def test_shift_by_25_days_gives_one_reminder_per_threshold(
    contracts: list[VendorContract],
    staff: list[User],
    template: MessageTemplate,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """Через 25 дней осталось 10 и 15 дней: пройдены пороги 30 и 15 у обоих."""
    with freeze_time(now() + timedelta(days=25)):
        assert run_task(django_capture_on_commit_callbacks) == 4
        # Повторный запуск в тот же день ничего не добавляет.
        assert run_task(django_capture_on_commit_callbacks) == 0

    for contract in contracts:
        for threshold in (30, 15):
            key = expiry.dedupe_key(contract, threshold)
            # По уведомлению каждому сотруднику и одно письмо поставщику.
            assert Notification.objects.filter(dedupe_key=key).count() == len(staff)
            assert OutboxMessage.objects.filter(dedupe_key=key).count() == 1
        assert not Notification.objects.filter(dedupe_key=expiry.dedupe_key(contract, 7)).exists()

    letter = OutboxMessage.objects.filter(template_code="contract_expiring").first()
    assert letter is not None
    assert contracts[0].number in letter.subject or contracts[1].number in letter.subject


def test_next_threshold_fires_later_and_only_once(
    contracts: list[VendorContract],
    staff: list[User],
    template: MessageTemplate,
    django_capture_on_commit_callbacks: Any,
) -> None:
    with freeze_time(now() + timedelta(days=25)):
        run_task(django_capture_on_commit_callbacks)
    with freeze_time(now() + timedelta(days=30)):
        # 35-дневный договор: осталось 5 дней — порог 7 пройден.
        assert run_task(django_capture_on_commit_callbacks) == 1
        assert run_task(django_capture_on_commit_callbacks) == 0

    total = Notification.objects.filter(kind="contract_expiry").count()
    assert total == 5 * len(staff)


def test_terminated_and_expired_contracts_are_skipped(
    contracts: list[VendorContract], staff: list[User], django_capture_on_commit_callbacks: Any
) -> None:
    first, second = contracts
    first.terminated_at = now()
    first.save()
    with freeze_time(now() + timedelta(days=50)):
        # Первый расторгнут, второй истёк 10 дней назад — напоминать не о чем.
        assert run_task(django_capture_on_commit_callbacks) == 0
