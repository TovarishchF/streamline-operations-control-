"""Заявки на услуги `[ТЗ 3.2.2]`.

На M4 заводится необходимый минимум: от заявок зависят guard-условия автомата
рейса (`shared/state-machines/flight.json`), и без них переходы `start`,
`ready` и `complete` проверить нечем.

Снимки цен, атрибуты, SLA, переназначение поставщика и документы — M5
(`DOMAIN.md § 4`, `TASKS.md`). Поля, которые появятся там, здесь намеренно
отсутствуют, а не заглушены пустыми значениями.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _
from django_fsm import FSMField

from catalog.models import Service, icao_validator
from core.models import BaseModel
from counterparties.models import Vendor
from flights.models import Flight, ServiceLeg


class ServiceOrderStatus(models.TextChoices):
    """Состояния по `shared/state-machines/service-order.json`."""

    DRAFT = "draft", _("Черновик")
    ORDERED = "ordered", _("Заказана")
    CONFIRMED = "confirmed", _("Подтверждена")
    IN_PROGRESS = "in_progress", _("Выполняется")
    COMPLETED = "completed", _("Выполнена")
    REJECTED = "rejected", _("Отклонена")
    CANCELLED = "cancelled", _("Отменена")


class ServiceOrder(BaseModel):
    """Заявка на услугу у поставщика."""

    id_prefix: ClassVar[str] = "ord"

    flight = models.ForeignKey(Flight, on_delete=models.CASCADE, related_name="service_orders")
    service = models.ForeignKey(Service, on_delete=models.PROTECT, related_name="orders")
    leg = models.CharField(max_length=16, choices=ServiceLeg.choices)
    # Выводится из плеча и рейса, но хранится: аэропорт вылета рейса можно
    # изменить, а заявка уже ушла поставщику в конкретный аэропорт.
    airport_icao = models.CharField(max_length=4, validators=[icao_validator])

    vendor = models.ForeignKey(
        Vendor, on_delete=models.PROTECT, related_name="orders", null=True, blank=True
    )

    status = FSMField(
        max_length=16,
        choices=ServiceOrderStatus.choices,
        default=ServiceOrderStatus.DRAFT,
        protected=True,
        db_index=True,
    )

    quantity = models.DecimalField(max_digits=18, decimal_places=4, default=1)
    attributes = models.JSONField(default=dict, blank=True)

    ordered_at = models.DateTimeField(null=True, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    class Meta:
        verbose_name = _("Заявка на услугу")
        verbose_name_plural = _("Заявки на услуги")
        ordering = ("flight", "leg", "created_at")
        indexes = (
            models.Index(fields=("flight",)),
            models.Index(fields=("vendor", "status")),
        )

    def __str__(self) -> str:
        return f"{self.flight.number}: {self.service.code} ({self.get_status_display()})"
