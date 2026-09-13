"""Журнал обменов с внешними системами `[ТЗ 4.2]`.

`INTEGRATIONS.md § 7`. Каждый вызов внешней системы попадает сюда: код
подключения, **фактический** режим, длительность, статус. Это доказательная
база при разборе спорных ситуаций с поставщиками и главный инструмент отладки
при переходе `stub → live`.

Поле `mode` — не украшение. `CLAUDE.md § 4`: заглушка не изображает живое
подключение, и по журналу всегда видно, откуда пришли данные.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import BaseModel


class IntegrationMode(models.TextChoices):
    LIVE = "live", _("Боевой режим")
    STUB = "stub", _("Заглушка")


class ExchangeStatus(models.TextChoices):
    OK = "ok", _("Успешно")
    ERROR = "error", _("Ошибка")
    TIMEOUT = "timeout", _("Таймаут")


class IntegrationLog(BaseModel):
    """Запись об обмене."""

    id_prefix: ClassVar[str] = "ilg"

    code = models.CharField(max_length=16, db_index=True, help_text=_("FX, WX, SMTP, …"))
    mode = models.CharField(
        max_length=8,
        choices=IntegrationMode.choices,
        help_text=_("Фактический режим на момент вызова"),
    )
    operation = models.CharField(max_length=64, help_text=_("rates_on_date, send, …"))
    endpoint = models.CharField(max_length=500, blank=True)

    status = models.CharField(max_length=8, choices=ExchangeStatus.choices, db_index=True)
    http_status = models.PositiveSmallIntegerField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)
    response_bytes = models.PositiveIntegerField(default=0)

    # Тела хранятся ограниченный срок (INTEGRATIONS § 7). Реквизиты доступа
    # и персональные данные сюда не попадают: их вырезает сам адаптер.
    request_body = models.TextField(blank=True)
    response_body = models.TextField(blank=True)
    error = models.TextField(blank=True)

    related_entity_type = models.CharField(max_length=32, blank=True)
    related_entity_id = models.CharField(max_length=40, blank=True)

    class Meta:
        verbose_name = _("Обмен с внешней системой")
        verbose_name_plural = _("Журнал обменов")
        ordering = ("-created_at",)
        indexes = (
            models.Index(fields=("code", "-created_at")),
            models.Index(fields=("status", "-created_at")),
        )

    def __str__(self) -> str:
        return f"{self.code} {self.operation} [{self.mode}] {self.status}"
