"""Регистрация фоновых задач в расписании `[ТЗ 4.1]` (`BACKEND.md § 5`).

`django-celery-beat` держит расписание в базе, а не в коде: иначе менять
периодичность можно было бы только выкладкой. Но пустая база означает, что
beat не запускает ничего, и это молчаливый отказ — очередь исходящих
просто не отправляется, и понять это можно только по тому, что письма
не приходят.

Команда идемпотентна: повторный запуск обновляет существующие записи
и не плодит дубли. Запускается при развёртывании.

В расписание попадают **только написанные** задачи. `BACKEND.md § 5`
перечисляет двенадцать, из них реализованы шесть; регистрировать
расписание для несуществующей задачи значило бы получить в логах beat
поток ошибок и считать, что проверка сроков контрактов работает.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.core.management.base import BaseCommand
from django.db import transaction

if TYPE_CHECKING:
    from argparse import ArgumentParser

# (имя задачи, вид расписания, значение, пояснение)
# Расписание — либо интервал в секундах, либо час и минута по UTC.
INTERVAL_TASKS: list[tuple[str, int, str]] = [
    ("comms.send_outbox", 30, "Отправка очереди исходящих"),
    ("flights.auto_depart", 60, "Автопереход рейса в «В полёте»"),
    ("flights.auto_arrive", 60, "Автопереход рейса в «Прибыл»"),
    ("comms.poll_inbox", 300, "Разбор входящей почты"),
    # Ежечасно: подписка задаёт час отправки, а точность до минуты
    # потребовала бы запуска каждую минуту ради одного письма в неделю.
    ("reports.scheduled", 3600, "Рассылка отчётов по подписке"),
]

CRON_TASKS: list[tuple[str, int, int, str]] = [
    ("fx.sync_rates", 6, 0, "Загрузка курсов валют"),
]


class Command(BaseCommand):
    help = "Создаёт и обновляет расписание фоновых задач"

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument(
            "--disable-missing",
            action="store_true",
            help="Отключить задачи в расписании, которых нет в этом перечне",
        )

    @transaction.atomic
    def handle(self, *args: Any, **options: Any) -> None:
        from django_celery_beat.models import CrontabSchedule, IntervalSchedule, PeriodicTask

        known: set[str] = set()

        for task, seconds, description in INTERVAL_TASKS:
            schedule, _ = IntervalSchedule.objects.get_or_create(
                every=seconds, period=IntervalSchedule.SECONDS
            )
            self._upsert(
                PeriodicTask,
                task=task,
                description=description,
                interval=schedule,
                crontab=None,
            )
            known.add(task)

        for task, hour, minute, description in CRON_TASKS:
            schedule, _ = CrontabSchedule.objects.get_or_create(
                minute=str(minute),
                hour=str(hour),
                day_of_week="*",
                day_of_month="*",
                month_of_year="*",
                timezone="UTC",
            )
            self._upsert(
                PeriodicTask,
                task=task,
                description=description,
                interval=None,
                crontab=schedule,
            )
            known.add(task)

        self.stdout.write(f"задач в расписании: {len(known)}")

        if options["disable_missing"]:
            stale = PeriodicTask.objects.exclude(task__in=known).exclude(
                name="celery.backend_cleanup"
            )
            count = stale.update(enabled=False)
            if count:
                self.stdout.write(f"отключено лишних: {count}")

    def _upsert(self, model: Any, *, task: str, description: str, **schedule: Any) -> None:
        """Заводит или обновляет запись расписания.

        Имя записи совпадает с именем задачи: одна задача — одно
        расписание, и второе для неё завести нельзя.
        """
        model.objects.update_or_create(
            name=task,
            defaults={"task": task, "description": description, "enabled": True, **schedule},
        )
