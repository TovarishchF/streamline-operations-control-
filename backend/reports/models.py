"""Подписки на отчёты по расписанию `[ТЗ 3.6.3]` (`SPEC.md § 9.3`).

Задача Celery beat формирует отчёт и ставит сообщение в исходящие.
Хранится здесь только описание подписки: сам отчёт строится в момент
отправки, а не берётся из сохранённого — за неделю данные меняются.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import BaseModel


class Schedule(models.TextChoices):
    DAILY = "daily", _("Ежедневно")
    WEEKLY = "weekly", _("Еженедельно")
    MONTHLY = "monthly", _("Ежемесячно")


class ExportFormat(models.TextChoices):
    PDF = "pdf", "PDF"
    XLSX = "xlsx", "XLSX"
    CSV = "csv", "CSV"
    XML = "xml", "XML"


class ReportSubscription(BaseModel):
    """Подписка на отчёт `[ТЗ 3.6.3]`."""

    id_prefix: ClassVar[str] = "rsb"

    code = models.CharField(max_length=32, db_index=True)
    schedule = models.CharField(max_length=8, choices=Schedule.choices)
    # Время в UTC: планировщик работает по серверным часам, а получатели
    # могут быть в разных зонах. Перевод в местное — на отображении.
    time_utc = models.CharField(max_length=5, default="06:00")
    export_format = models.CharField(
        max_length=8, choices=ExportFormat.choices, default=ExportFormat.XLSX
    )
    recipients = models.JSONField(default=list)
    # Параметры отчёта: период задаётся относительно даты отправки,
    # а не абсолютными датами — подписка на «прошлую неделю» должна
    # каждый раз брать прошлую неделю.
    parameters = models.JSONField(default=dict, blank=True)

    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Подписка на отчёт")
        verbose_name_plural = _("Подписки на отчёты")
        ordering = ("code", "schedule")

    def __str__(self) -> str:
        return f"{self.code} · {self.get_schedule_display()}"


class DashboardRole(models.TextChoices):
    DISPATCHER = "dispatcher", _("Диспетчер")
    MANAGER = "manager", _("Руководитель")


class DashboardLayout(BaseModel):
    """Раскладка виджетов дашборда на пользователя `[ТЗ 3.6.2]`.

    Состав и положение виджетов — `[{code, x, y, w, h}]`. Пользователь,
    не настраивавший дашборд, видит раскладку по умолчанию, и записи
    для него нет: умолчание живёт в коде и меняется вместе с составом
    виджетов, а не застывает в базе.
    """

    id_prefix: ClassVar[str] = "dbl"

    user = models.ForeignKey(
        "accounts.User", on_delete=models.CASCADE, related_name="dashboard_layouts"
    )
    role = models.CharField(max_length=16, choices=DashboardRole.choices)
    widgets = models.JSONField(default=list)

    class Meta:
        verbose_name = _("Раскладка дашборда")
        verbose_name_plural = _("Раскладки дашбордов")
        constraints = (
            models.UniqueConstraint(fields=("user", "role"), name="dashboard_layout_per_user"),
        )

    def __str__(self) -> str:
        return f"{self.user_id}: {self.role}"
