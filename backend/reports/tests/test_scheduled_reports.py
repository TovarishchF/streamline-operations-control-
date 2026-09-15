"""Рассылка отчётов по подписке `[ТЗ 3.6.3]` (`SPEC.md § 9.3`).

Отчёт строится в момент отправки, а не берётся сохранённым, и уходит
вложением: подписанная ссылка живёт четверть часа и к утру бесполезна.

Отдельно проверяется идемпотентность: задача запускается ежечасно,
и второй запуск в тот же период не должен слать второе письмо.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from comms.models import OutboxMessage
from core.clock import now
from core.services import storage
from reports.models import ExportFormat, ReportSubscription, Schedule
from reports.tasks import send_scheduled_reports

if TYPE_CHECKING:
    from comms.models import MessageTemplate

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def storage_stub(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    stored: dict[str, Any] = {}

    def fake_put(*, key: str, data: bytes, mime_type: str) -> None:
        stored[key] = data

    monkeypatch.setattr(storage, "put_bytes", fake_put)
    monkeypatch.setattr(storage, "object_size", lambda key: len(stored.get(key, b"")) or 1)
    monkeypatch.setattr(
        storage, "presign_get", lambda *, key, file_name: f"http://storage.test/{key}"
    )
    return stored


@pytest.fixture
def report_template(db: None) -> MessageTemplate:
    from comms.models import MessageChannel, MessageTemplate

    return MessageTemplate.objects.create(
        code="report_scheduled",
        channel=MessageChannel.EMAIL,
        subject_ru="Отчёт «{{report.name}}» за {{report.period}}",
        subject_en="Report {{report.name}} for {{report.period}}",
        body_ru="Во вложении отчёт за {{report.period}}.",
        body_en="Please find the report for {{report.period}} attached.",
    )


@pytest.fixture
def subscription(db: None) -> ReportSubscription:
    """Подписка со временем отправки в текущем часе."""
    return ReportSubscription.objects.create(
        code="flights_period",
        schedule=Schedule.WEEKLY,
        time_utc=f"{now():%H}:00",
        export_format=ExportFormat.CSV,
        recipients=["ops@example.test"],
    )


def test_subscription_produces_a_letter_with_the_report_attached(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    assert send_scheduled_reports() == 1

    message = OutboxMessage.objects.get()
    assert message.template_code == "report_scheduled"
    assert message.to[0]["address"] == "ops@example.test"
    assert message.related_entity_type == "report_subscription"
    assert message.related_entity_id == subscription.pk

    attachment = message.attachments.get()
    assert attachment.file_name == "flights_period.csv"
    assert attachment.uploaded_at is not None


def test_report_name_and_period_reach_the_letter(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    send_scheduled_reports()
    message = OutboxMessage.objects.get()

    assert "Рейсы за период" in message.subject
    # Период относительный: подписка на неделю берёт последнюю неделю
    assert "—" in message.subject
    assert "{{" not in message.body, "в письме осталась неподставленная переменная"


def test_second_run_in_the_same_period_sends_nothing(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    """Задача идёт ежечасно, а отчёт за неделю нужен один раз."""
    assert send_scheduled_reports() == 1
    assert send_scheduled_reports() == 0
    assert OutboxMessage.objects.count() == 1


def test_subscription_outside_its_hour_is_skipped(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    other_hour = (now().hour + 3) % 24
    subscription.time_utc = f"{other_hour:02d}:00"
    subscription.save()

    assert send_scheduled_reports() == 0


def test_deactivated_subscription_is_not_sent(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    subscription.is_active = False
    subscription.save()

    assert send_scheduled_reports() == 0


def test_every_recipient_gets_their_own_letter(
    subscription: ReportSubscription, report_template: MessageTemplate
) -> None:
    """Адреса подписчиков не показываются друг другу."""
    subscription.recipients = ["one@example.test", "two@example.test"]
    subscription.save()

    send_scheduled_reports()

    messages = list(OutboxMessage.objects.all())
    assert len(messages) == 2
    for message in messages:
        assert len(message.to) == 1
