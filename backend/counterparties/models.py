"""Контрагенты: клиенты и поставщики.

На M3 заводится необходимый минимум — эти модели нужны как цель связи
пользователя с ролью «Клиент» или «Поставщик»: по ним работает фильтрация
выборки (`BACKEND.md § 3.7`), а без них мультиарендность проверить нечем.

Контракты, тарифы, прайсы, сертификаты, рейтинг и контакты — M6
(`DOMAIN.md § 3`, `TASKS.md`). Поля, которые добавятся там, здесь намеренно
отсутствуют, а не заглушены пустыми значениями.

Наименования контрагентов в демонстрационных данных вымышлены (`CLAUDE.md § 4`).
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _

from accounts.models import Organization
from core.models import BaseModel


class Client(BaseModel):
    """Авиакомпания-заказчик `[ТЗ 3.3]`."""

    id_prefix: ClassVar[str] = "cli"

    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="clients"
    )
    name = models.CharField(max_length=255, db_index=True)
    legal_name = models.CharField(max_length=500, blank=True)
    country = models.CharField(max_length=2, blank=True, help_text=_("ISO 3166-1 alpha-2"))
    settlement_currency = models.CharField(max_length=3, default="RUB")
    default_locale = models.CharField(
        max_length=2, choices=[("ru", "ru"), ("en", "en")], default="ru"
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Клиент")
        verbose_name_plural = _("Клиенты")
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name


class Vendor(BaseModel):
    """Поставщик услуг `[ТЗ 3.3.1]`."""

    id_prefix: ClassVar[str] = "ven"

    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="vendors"
    )
    name = models.CharField(max_length=255, db_index=True)
    legal_name = models.CharField(max_length=500, blank=True)
    country = models.CharField(max_length=2, blank=True, help_text=_("ISO 3166-1 alpha-2"))
    settlement_currency = models.CharField(max_length=3, default="RUB")
    # Категории услуг, которые поставщик оказывает. Массив кодов
    # catalog.ServiceCategory: по нему идёт подбор поставщика (DOMAIN.md § 7.5).
    specializations = models.JSONField(default=list, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Поставщик")
        verbose_name_plural = _("Поставщики")
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name
