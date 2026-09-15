"""Очередь исходящих `[ТЗ 3.5.2]` (`SPEC.md § 8.2`).

Проверяется то, из-за чего в очереди сообщений теряют письма:

* отказ канала не выбрасывает сообщение, а откладывает его;
* попытки кончаются, и тогда сообщение ждёт человека, а не исчезает;
* повтор отправленного запрещён — второй экземпляр письма поставщику
  читается как второй заказ;
* заглушка не выдаёт себя за отправку наружу (`CLAUDE.md § 4`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from comms.models import MessageChannel, OutboxMessage, OutboxStatus
from comms.services import outbox
from core.services import storage
from integrations.channels import MAX_ATTEMPTS, ChannelError, Message, Recipient

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from comms.models import MessageTemplate

pytestmark = pytest.mark.django_db

URL = "/api/v1/outbox"


def idempotent(key: str = "out-key-00000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture(autouse=True)
def storage_stub(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Хранилище подменяется: проверяется очередь, а не MinIO."""
    stored: dict[str, Any] = {}

    def fake_put(*, key: str, data: bytes, mime_type: str) -> None:
        stored["key"] = key
        stored["data"] = data

    monkeypatch.setattr(storage, "put_bytes", fake_put)
    monkeypatch.setattr(
        storage, "presign_get", lambda *, key, file_name: f"http://storage.test/{key}"
    )
    return stored


# ─────────────────────────── Постановка в очередь ───────────────────────────


def test_enqueued_message_records_the_actual_channel_mode(db: None) -> None:
    """`CLAUDE.md § 4`: режим записывается, а не вычисляется при показе."""
    message = outbox.enqueue(
        channel=MessageChannel.EMAIL,
        to=[{"name": "Поставщик", "address": "ops@vendor.test"}],
        subject="Заявка",
        body="Текст",
    )
    assert message.channel_mode == "stub"
    assert message.status == OutboxStatus.QUEUED


def test_demo_stand_marks_the_subject(db: None, settings: Any) -> None:
    """`SPEC.md § 8.6`: письмо со стенда опознаётся получателем."""
    settings.DEMO_DATA = True
    message = outbox.enqueue(
        channel=MessageChannel.EMAIL,
        to=[{"name": "Поставщик", "address": "ops@vendor.test"}],
        subject="Заявка на обслуживание",
        body="Текст",
    )
    assert message.subject.startswith("[DEMO] ")

    settings.DEMO_DATA = False
    production = outbox.enqueue(
        channel=MessageChannel.EMAIL,
        to=[{"name": "Поставщик", "address": "ops@vendor.test"}],
        subject="Заявка на обслуживание",
        body="Текст",
    )
    assert not production.subject.startswith("[DEMO]")


def test_template_is_rendered_into_the_message(
    template: MessageTemplate, order: Any
) -> None:
    from comms.services import context

    message = outbox.enqueue_from_template(
        code=template.code,
        to=[{"name": "Поставщик", "address": "ops@vendor.test", "locale": "ru"}],
        data=context.for_flight(order.flight),
        related=("service_order", order.pk),
    )

    assert order.pk in message.subject
    assert order.flight.number in message.body
    assert message.template_code == template.code
    assert message.related_entity_id == order.pk


def test_english_recipient_gets_the_english_text(
    template: MessageTemplate, order: Any
) -> None:
    """Язык письма — по локали получателя, а не интерфейса отправителя."""
    from comms.services import context

    message = outbox.enqueue_from_template(
        code=template.code,
        to=[{"name": "Vendor", "address": "ops@vendor.test", "locale": "en"}],
        data=context.for_flight(order.flight),
    )
    assert message.body.startswith("Flight ")


# ─────────────────────────── Отправка ───────────────────────────


def test_stub_marks_the_message_sent_but_not_delivered(
    queued_message: OutboxMessage,
) -> None:
    """Заглушка не подтверждает доставку, которую подтвердить не может."""
    sent = outbox.send(queued_message)

    assert sent.status == OutboxStatus.SENT
    assert sent.status != OutboxStatus.DELIVERED
    assert sent.sent_at is not None
    assert sent.attempts == 1


def test_sent_email_keeps_a_copy_of_the_letter(
    queued_message: OutboxMessage, storage_stub: dict[str, Any]
) -> None:
    """Файл письма — то же самое, что ушло бы наружу."""
    sent = outbox.send(queued_message)

    assert sent.eml_key
    assert storage_stub["key"] == sent.eml_key
    assert b"Subject:" in storage_stub["data"]
    assert outbox.eml_url(sent) == f"http://storage.test/{sent.eml_key}"


def test_channel_failure_postpones_instead_of_losing(
    queued_message: OutboxMessage, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Отказ канала — повод повторить, а не потерять заявку поставщику."""
    monkeypatch.setattr(
        outbox, "get_provider", lambda code: _FailingProvider()
    )

    failed = outbox.send(queued_message)

    assert failed.status == OutboxStatus.QUEUED
    assert failed.next_attempt_at is not None
    assert "ChannelError" in failed.last_error


def test_attempts_run_out_and_the_message_waits_for_a_human(
    queued_message: OutboxMessage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(outbox, "get_provider", lambda code: _FailingProvider())

    message = queued_message
    for _ in range(MAX_ATTEMPTS):
        message = outbox.send(message)

    assert message.attempts == MAX_ATTEMPTS
    assert message.status == OutboxStatus.FAILED
    assert message.next_attempt_at is None
    # Сообщение на месте и видно на экране, а не удалено
    assert OutboxMessage.objects.filter(pk=message.pk).exists()


def test_due_selection_skips_postponed_messages(
    queued_message: OutboxMessage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(outbox, "get_provider", lambda code: _FailingProvider())
    outbox.send(queued_message)

    assert list(outbox.due_messages()) == []


def test_portal_message_needs_no_external_channel(db: None) -> None:
    message = outbox.enqueue(
        channel=MessageChannel.PORTAL,
        to=[{"name": "Клиент", "address": "portal"}],
        subject="Счёт выставлен",
        body="Текст",
    )
    sent = outbox.send(message)
    assert sent.status == OutboxStatus.DELIVERED


# ─────────────────────────── Повтор по кнопке ───────────────────────────


def test_retry_endpoint_sends_a_failed_message(
    as_role: Callable[..., APIClient],
    queued_message: OutboxMessage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Канал отказывает, пока не сказано иначе. Флагом, а не `monkeypatch.undo()`:
    # тот снял бы и подмену хранилища, поставленную приспособлением.
    broken = {"value": True}
    from integrations.base import get_provider

    working = get_provider("SMTP")
    monkeypatch.setattr(
        outbox,
        "get_provider",
        lambda code: _FailingProvider() if broken["value"] else working,
    )

    for _ in range(MAX_ATTEMPTS):
        queued_message = outbox.send(queued_message)
    assert queued_message.status == OutboxStatus.FAILED

    broken["value"] = False

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{queued_message.pk}/retry", format="json", headers=idempotent()
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["status"] == OutboxStatus.SENT
    assert response.json()["attempts"] == 1


def test_sent_message_cannot_be_retried(
    as_role: Callable[..., APIClient], queued_message: OutboxMessage
) -> None:
    """Второй экземпляр письма поставщику читается как второй заказ."""
    outbox.send(queued_message)

    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{queued_message.pk}/retry",
        format="json",
        headers=idempotent("out-twice-0001"),
    )
    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["error"]["code"] == "MESSAGE_ALREADY_SENT"


def test_retry_requires_idempotency_key(
    as_role: Callable[..., APIClient], queued_message: OutboxMessage
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(f"{URL}/{queued_message.pk}/retry", format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


# ─────────────────────────── Список ───────────────────────────


def test_list_shows_channel_mode_and_eml_link(
    as_role: Callable[..., APIClient], queued_message: OutboxMessage
) -> None:
    outbox.send(queued_message)

    api = as_role(Role.DISPATCHER)
    response = api.get(URL)

    assert response.status_code == status.HTTP_200_OK
    row = response.json()["data"][0]
    assert row["channelMode"] == "stub"
    assert row["emlUrl"].startswith("http://storage.test/messages/")
    assert row["lastError"] is None


def test_list_can_be_filtered_by_status(
    as_role: Callable[..., APIClient], queued_message: OutboxMessage
) -> None:
    api = as_role(Role.DISPATCHER)
    assert len(api.get(f"{URL}?status=queued").json()["data"]) == 1
    assert api.get(f"{URL}?status=failed").json()["data"] == []


def test_portal_role_has_no_access_to_the_queue(
    as_role: Callable[..., APIClient], client_alpha: Any
) -> None:
    """Переписка оператора с поставщиками клиенту не показывается."""
    api = as_role(Role.CLIENT, client=client_alpha)
    assert api.get(URL).status_code == status.HTTP_403_FORBIDDEN


class _FailingProvider:
    """Канал, который отказывает."""

    code = "SMTP"

    def send(self, message: Message) -> tuple[object, object]:
        assert isinstance(message.to[0], Recipient)
        raise ChannelError("сервер исходящей почты недоступен")
