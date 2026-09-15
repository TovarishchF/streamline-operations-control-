"""Входящие внешние события `[ТЗ 3.2.2]` (`SPEC.md § 8.3`).

Главное, что здесь проверяется, — разбор **предлагает**, а не решает.
Опознанное письмо не меняет статус заявки само: это делает человек,
и запись в аудите стоит на его имени.

Нераспознанное письмо — штатный исход. Тест на него есть не потому, что
это ошибка, а потому что это половина рабочего дня диспетчера.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from comms.models import InboxMessage
from comms.services import inbox
from core.clock import now
from integrations.mailbot.base import IncomingMail

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from orders.models import ServiceOrder

pytestmark = pytest.mark.django_db

URL = "/api/v1/inbox"


def idempotent(key: str = "inb-key-00000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


def mail(subject: str, body: str, *, external_id: str = "mail-1") -> IncomingMail:
    return IncomingMail(
        external_id=external_id,
        sender="ops@vendor.test",
        subject=subject,
        body=body,
        received_at=now(),
    )


# ─────────────────────────── Разбор ───────────────────────────


def test_confirmation_is_recognized_and_linked_to_the_order(order: ServiceOrder) -> None:
    message = inbox.ingest(
        mail(f"Re: Заявка {order.pk}", "Подтверждаем заявку, работы выполним в срок.")
    )

    assert message.recognized is True
    assert message.service_order_id == order.pk
    assert message.suggested_action == "confirm"
    # Разбор не тронул заявку: применяет человек
    assert message.applied_at is None


def test_rejection_is_recognized(order: ServiceOrder) -> None:
    message = inbox.ingest(
        mail(f"Re: Заявка {order.pk}", "К сожалению, вынуждены отказать: нет техники.")
    )
    assert message.suggested_action == "reject"


def test_refusal_to_confirm_is_not_read_as_confirmation(order: ServiceOrder) -> None:
    """«Подтвердить не сможем» содержит оба признака — и это отказ."""
    message = inbox.ingest(
        mail(f"Re: Заявка {order.pk}", "Подтвердить заявку не сможем, борт занят.")
    )
    assert message.suggested_action == "reject"


def test_letter_without_order_number_goes_to_manual_queue(db: None) -> None:
    """`INTEGRATIONS.md § 3.3`: это штатный сценарий, а не ошибка."""
    message = inbox.ingest(mail("Уточнение по обслуживанию", "Перезвоните, пожалуйста."))

    assert message.recognized is False
    assert message.service_order_id is None
    assert message.suggested_action == ""


def test_letter_about_order_without_intent_is_not_recognized(order: ServiceOrder) -> None:
    """Заявка названа, намерения нет — это переписка, применять нечего."""
    message = inbox.ingest(
        mail(f"Заявка {order.pk}", "Уточните, пожалуйста, точное время подачи.")
    )
    assert message.recognized is False


def test_same_letter_is_not_ingested_twice(order: ServiceOrder) -> None:
    """`BACKEND.md § 5`: повторная выборка из ящика идемпотентна."""
    first = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем.", external_id="dup-1"))
    second = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем.", external_id="dup-1"))

    assert first.pk == second.pk
    assert InboxMessage.objects.count() == 1


def test_stub_source_is_marked_synthetic(order: ServiceOrder) -> None:
    """`CLAUDE.md § 4`: письмо от генератора не выдаётся за настоящее."""
    message = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем."))
    assert message.data_source == "synthetic"


# ─────────────────────────── Генератор ───────────────────────────


def test_generator_builds_letters_from_real_pending_orders(order: ServiceOrder) -> None:
    created = inbox.poll(10)

    assert created >= 0
    for message in InboxMessage.objects.all():
        # Письмо либо про настоящую заявку, либо честно нераспознанное
        assert message.service_order_id in (order.pk, None)


def test_generator_is_deterministic(order: ServiceOrder) -> None:
    """Стенд, показывающий разные ответы при каждом обновлении, разбирать нельзя."""
    from integrations.mailbot.stub import Provider

    first, _ = Provider().fetch(10)
    InboxMessage.objects.all().delete()
    second, _ = Provider().fetch(10)

    assert [item.subject for item in first] == [item.subject for item in second]


# ─────────────────────────── Применение ───────────────────────────


def test_apply_moves_the_order_and_records_the_human(
    as_role: Callable[..., APIClient], order: ServiceOrder
) -> None:
    message = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем заявку."))

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{message.pk}/apply", {}, format="json", headers=idempotent()
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["appliedAt"] is not None

    from orders.models import ServiceOrder as Order

    assert Order.objects.get(pk=order.pk).status == "confirmed"

    entry = AuditEntry.objects.filter(
        entity_type="inbox_message", entity_id=message.pk, action="applied"
    ).first()
    assert entry is not None
    assert entry.actor_role == Role.DISPATCHER


def test_unrecognized_letter_can_be_processed_manually(
    as_role: Callable[..., APIClient], order: ServiceOrder
) -> None:
    """Кнопка «Обработать вручную»: заявку и действие указывает диспетчер."""
    message = inbox.ingest(mail("Уточнение", "Текст без номера заявки."))
    assert message.recognized is False

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{message.pk}/apply",
        {"serviceOrderId": order.pk, "transition": "confirm"},
        format="json",
        headers=idempotent("inb-manual-001"),
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["serviceOrderId"] == order.pk
    assert response.json()["recognized"] is True


def test_unrecognized_letter_without_instructions_is_refused(
    as_role: Callable[..., APIClient],
) -> None:
    message = inbox.ingest(mail("Уточнение", "Текст без номера заявки."))

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{message.pk}/apply", {}, format="json", headers=idempotent("inb-empty-001")
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_applying_twice_is_refused(
    as_role: Callable[..., APIClient], order: ServiceOrder
) -> None:
    message = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем."))

    api = as_role(Role.DISPATCHER)
    api.post(f"{URL}/{message.pk}/apply", {}, format="json", headers=idempotent("inb-a-0001"))
    again = api.post(
        f"{URL}/{message.pk}/apply", {}, format="json", headers=idempotent("inb-a-0002")
    )

    assert again.status_code == status.HTTP_409_CONFLICT
    assert again.json()["error"]["code"] == "INBOX_ALREADY_APPLIED"


def test_apply_to_missing_order_is_not_found(
    as_role: Callable[..., APIClient],
) -> None:
    message = inbox.ingest(mail("Уточнение", "Текст."))

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{message.pk}/apply",
        {"serviceOrderId": "ord_00000000000000000000", "transition": "confirm"},
        format="json",
        headers=idempotent("inb-miss-0001"),
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


# ─────────────────────────── Список и права ───────────────────────────


def test_unrecognized_filter(
    as_role: Callable[..., APIClient], order: ServiceOrder
) -> None:
    inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем.", external_id="ok-1"))
    inbox.ingest(mail("Уточнение", "Без номера.", external_id="no-1"))

    api = as_role(Role.DISPATCHER)
    assert len(api.get(URL).json()["data"]) == 2
    only = api.get(f"{URL}?unrecognizedOnly=true").json()["data"]
    assert len(only) == 1
    assert only[0]["recognized"] is False


def test_sender_is_exposed_under_the_contract_name(
    as_role: Callable[..., APIClient],
) -> None:
    """В контракте поле называется `from` — это ключевое слово Python."""
    inbox.ingest(mail("Уточнение", "Текст."))

    api = as_role(Role.DISPATCHER)
    row = api.get(URL).json()["data"][0]
    assert row["from"] == "ops@vendor.test"


def test_portal_role_has_no_access_to_the_inbox(
    as_role: Callable[..., APIClient], vendor_alpha: Any
) -> None:
    api = as_role(Role.VENDOR, vendor=vendor_alpha)
    assert api.get(URL).status_code == status.HTTP_403_FORBIDDEN


def test_expired_order_confirmation_still_reaches_the_machine(
    as_role: Callable[..., APIClient], order: ServiceOrder
) -> None:
    """Разбор не подменяет проверки автомата.

    Заявка, срок подтверждения которой прошёл, подтверждается всё равно —
    но признак нарушения SLA ставит переход, а не разбор письма.
    """
    from orders.models import ServiceOrder as Order

    Order.objects.filter(pk=order.pk).update(sla_confirm_deadline=now() - timedelta(hours=2))
    message = inbox.ingest(mail(f"Заявка {order.pk}", "Подтверждаем."))

    api = as_role(Role.DISPATCHER)
    api.post(f"{URL}/{message.pk}/apply", {}, format="json", headers=idempotent())

    refreshed = Order.objects.get(pk=order.pk)
    assert refreshed.status == "confirmed"
    assert refreshed.sla_breached is True
