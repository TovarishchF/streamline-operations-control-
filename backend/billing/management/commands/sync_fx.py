"""Загрузка курсов валют `[ТЗ 3.4.1]`.

`make sync-fx`. По умолчанию — за сегодня; `--days N` дозагружает историю,
которая нужна демонстрационному стенду: документ ссылается на курс своей
даты, и без истории старые рейсы считать нечем.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.core.management.base import BaseCommand

from billing.services import fx
from core import clock
from integrations.base import mode_for

if TYPE_CHECKING:
    from argparse import ArgumentParser


class Command(BaseCommand):
    help = "Загружает курсы валют за сегодня или за последние N дней"

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--days", type=int, default=1, help="Сколько дней назад загрузить")

    def handle(self, *args: Any, **options: Any) -> None:
        days = max(1, int(options["days"]))
        today = clock.now().date()
        self.stdout.write(f"режим подключения FX: {mode_for('FX')}")

        loaded = 0
        failed = 0
        for offset in range(days):
            target = today - timedelta(days=offset)
            try:
                loaded += fx.sync_rates(target)
            except Exception as error:
                # Один недоступный день не должен ронять загрузку истории:
                # пропуски видны по отсутствию записей, а не по обрыву.
                failed += 1
                self.stderr.write(f"{target:%d.%m.%Y}: {error}")

        self.stdout.write(f"записей курсов: {loaded}, дней с ошибкой: {failed}")
