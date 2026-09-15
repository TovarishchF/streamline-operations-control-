"""Журнал действий `[ТЗ 3.6.3, 4.3]`.

`DOMAIN.md § 8`. Запись неизменяема: у слайса аудита есть только вставка.
Запрет обеспечен не только кодом — код можно обойти, — но и самой базой
(`BACKEND.md § 3.9`, ADR-033).

Модель намеренно не наследует `BaseModel`: у той есть `updated_at` и `version`,
то есть встроенное предположение, что запись изменяется. Здесь его нет.
"""

from __future__ import annotations

from typing import Any

from django.db import models
from django.utils.translation import gettext_lazy as _

from accounts.models import Role
from core.models import make_id


class AuditSource(models.TextChoices):
    """Происхождение записи.

    `SEED` виден в интерфейсе отдельным тегом с автором «System (демо-генератор)»
    и не выдаётся за действие человека (`CLAUDE.md § 4`).
    """

    USER = "user", _("Действие пользователя")
    SYSTEM = "system", _("Автоматический переход")
    SEED = "seed", _("Демонстрационный генератор")


class AuditEntityType(models.TextChoices):
    FLIGHT = "flight", _("Рейс")
    SERVICE_ORDER = "service_order", _("Заявка на услугу")
    VENDOR = "vendor", _("Поставщик")
    CLIENT = "client", _("Клиент")
    CONTRACT = "contract", _("Контракт")
    TARIFF = "tariff", _("Тариф")
    QUOTE = "quote", _("Котировка")
    INVOICE = "invoice", _("Счёт")
    PAYABLE = "payable", _("Заявка на оплату")
    PAYMENT = "payment", _("Платёж")
    RECONCILIATION = "reconciliation", _("Сверка")
    USER = "user", _("Пользователь")
    SETTINGS = "settings", _("Настройки")
    CREW = "crew", _("Экипаж")
    AIRCRAFT = "aircraft", _("Воздушное судно")
    SERVICE = "service", _("Услуга каталога")
    REPORT_SUBSCRIPTION = "report_subscription", _("Подписка на отчёт")
    VENDOR_PRICE = "vendor_price", _("Цена поставщика")
    AIRPORT = "airport", _("Аэропорт")


class AuditEntry(models.Model):
    """Запись аудита."""

    id = models.CharField(primary_key=True, max_length=40, editable=False)

    # Реальное время действия. Модельное время стенда сюда не подмешивается:
    # запись о том, что произошло, датируется тем, когда это произошло (ADR-014).
    ts = models.DateTimeField(db_index=True)
    clock_shifted = models.BooleanField(
        default=False, help_text=_("Действие совершено при сдвинутом модельном времени")
    )

    actor_id = models.CharField(max_length=40, db_index=True)
    actor_name = models.CharField(max_length=255)
    actor_role = models.CharField(max_length=16, choices=Role.choices)
    source = models.CharField(max_length=8, choices=AuditSource.choices, default=AuditSource.USER)

    entity_type = models.CharField(max_length=24, choices=AuditEntityType.choices)
    entity_id = models.CharField(max_length=40)
    action = models.CharField(max_length=64, help_text=_("status_changed, vendor_assigned, …"))

    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    comment = models.TextField(blank=True)

    is_demo = models.BooleanField(default=False, db_index=True)

    class Meta:
        verbose_name = _("Запись аудита")
        verbose_name_plural = _("Журнал действий")
        ordering = ("-ts", "-id")
        indexes = (
            models.Index(fields=("entity_type", "entity_id", "-ts")),
            models.Index(fields=("actor_id", "-ts")),
        )

    def __str__(self) -> str:
        return f"{self.ts:%Y-%m-%d %H:%M:%SZ} {self.actor_name}: {self.action} {self.entity_id}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        """Только вставка.

        База откажет и без этой проверки (триггер из миграции 0002), но
        сообщение оттуда — про нарушение ограничения. Здесь ошибка внятная
        и возникает до похода в базу.
        """
        if not self._state.adding:
            raise AuditEntryImmutable
        if not self.id:
            self.id = make_id("aud")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise AuditEntryImmutable


class AuditEntryImmutable(Exception):
    """Попытка изменить или удалить запись аудита."""

    def __init__(self) -> None:
        super().__init__("Запись аудита неизменяема: допускается только добавление")
