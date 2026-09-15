"""Рассылка отчётов по подписке `[ТЗ 3.6.3]` (`SPEC.md § 9.3`, `BACKEND.md § 5`).

Задача `reports.scheduled` запускается ежечасно и отбирает подписки,
у которых наступило их время. Отчёт строится в момент отправки, а не
берётся сохранённым: за неделю данные меняются, и подписчик ждёт свежий
отчёт, а не копию прошлого.

Задача идемпотентна: второй запуск в тот же период письма не создаст —
признаком служит уже созданное исходящее сообщение.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from celery import shared_task

from core import clock

if TYPE_CHECKING:
    from reports.models import ReportSubscription

logger = logging.getLogger(__name__)

# Длина периода отчёта по расписанию, в сутках.
PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}


@shared_task(name="reports.scheduled")  # type: ignore[misc]
def send_scheduled_reports() -> int:
    """Рассылка отчётов по подписке `[ТЗ 3.6.3]` (`SPEC.md § 9.3`).

    Отчёт строится в момент отправки, а не берётся сохранённым: за неделю
    данные меняются, и подписчик ждёт свежий отчёт, а не копию прошлого.

    Файл уходит вложением, а не ссылкой: подписанная ссылка живёт четверть
    часа, и письмо с ней бесполезно уже к утру.
    """
    from reports.models import ReportSubscription

    current = clock.now()
    sent = 0

    for subscription in ReportSubscription.objects.filter(is_active=True):
        if not _is_due(subscription, current) or _already_sent(subscription, current):
            continue
        _send_subscription(subscription, current)
        sent += 1

    if sent:
        logger.info("отчёты по подписке: отправлено %s", sent)
    return sent


def _is_due(subscription: ReportSubscription, current: datetime) -> bool:
    """Наступило ли время отправки.

    Задача запускается ежечасно, поэтому сравнивается час: совпадение
    с точностью до минуты требовало бы запуска каждую минуту, а отчёт
    за неделю не становится хуже от того, что ушёл в 06:40 вместо 06:30.
    """
    hour, _minute = str(subscription.time_utc).split(":")
    return current.hour == int(hour)


def _already_sent(subscription: ReportSubscription, current: datetime) -> bool:
    from comms.models import OutboxMessage

    span = PERIOD_DAYS.get(subscription.schedule, 7)
    # Окно чуть короче периода: суточная подписка не должна пропускать
    # отправку из-за того, что вчерашняя случилась на час позже.
    since = current - timedelta(days=span) + timedelta(hours=1)
    return OutboxMessage.objects.filter(
        related_entity_type="report_subscription",
        related_entity_id=subscription.pk,
        created_at__gte=since,
    ).exists()


def _period(subscription: ReportSubscription, current: datetime) -> dict[str, Any]:
    """Параметры отчёта относительно даты отправки.

    Подписка на «прошлую неделю» обязана каждый раз брать прошлую неделю,
    поэтому период считается от текущей даты, а не хранится абсолютным.
    """
    span = PERIOD_DAYS.get(subscription.schedule, 7)
    params: dict[str, Any] = dict(subscription.parameters or {})
    params["from"] = (current - timedelta(days=span)).date()
    params["to"] = current.date()
    return params


def _send_subscription(subscription: ReportSubscription, current: datetime) -> None:
    from comms.services import context, outbox
    from core.models import AttachmentKind
    from core.services import attachments
    from reports import definitions
    from reports.services import builders, export

    params = _period(subscription, current)
    result = builders.build(subscription.code, params)
    # Отчёт собирается один раз, а кладётся в хранилище отдельно под каждое
    # письмо: вложение принадлежит своему сообщению, и один объект
    # хранилища на два вложения завести нельзя.
    rendered = export.render_report(
        code=subscription.code,
        result=result,
        export_format=subscription.export_format,
        params=params,
    )

    spec = definitions.definition(subscription.code)
    data = {
        "report": {
            "name": spec.ru,
            "period": f"{params['from']} — {params['to']}",
            "generatedAt": result["generatedAt"],
        },
        "operator": context.operator_data(),
    }

    # Каждому получателю своё письмо: адреса подписчиков не показываются
    # друг другу, а язык письма выбирается по получателю.
    for address in subscription.recipients:
        message = outbox.enqueue_from_template(
            code="report_scheduled",
            to=[{"name": address, "address": address, "locale": "ru"}],
            data=data,
            related=("report_subscription", subscription.pk),
        )
        produced = export.store(
            rendered=rendered, key=f"messages/{message.pk}/{rendered.file_name}"
        )
        attachments.attach_stored(
            key=produced.key,
            file_name=produced.file_name,
            mime_type=produced.mime_type,
            kind=AttachmentKind.OTHER,
            owner=message,
        )
