"""Пользователи и роли.

На M1 заводится только модель — она нужна как `AUTH_USER_MODEL` до появления
любых других таблиц. Права, 2FA, LDAP и фильтрация по арендатору — M3
(`TASKS.md`).
"""

from __future__ import annotations

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import make_id


class Role(models.TextChoices):
    """Роли из `SPEC.md § 2.2`.

    `SALES` добавлена по ТЗ 2.1 (ADR-011): отдел продаж указан участником процесса,
    но в матрице ролей ТЗ 4.3 отсутствует. Подтверждение заказчика — G-06.
    """

    ADMIN = "admin", _("Администратор")
    DISPATCHER = "dispatcher", _("Диспетчер")
    SALES = "sales", _("Продажи")
    FINANCE = "finance", _("Финансист")
    MANAGER = "manager", _("Руководитель")
    CLIENT = "client", _("Клиент")
    VENDOR = "vendor", _("Поставщик")


class TimezoneMode(models.TextChoices):
    UTC = "utc", _("UTC")
    AIRPORT_LOCAL = "airport_local", _("Местное время аэропорта")
    USER_LOCAL = "user_local", _("Местное время пользователя")


class Organization(models.Model):
    """Арендатор-эксплуатант платформы (ADR-003).

    Верхний уровень изоляции. В установке on-premise организация одна и фильтр
    вырождается; в SaaS он отделяет одну экспедиторскую компанию от другой.
    Добавлен до первой доменной модели намеренно: позже это миграция с простоем.
    """

    id = models.CharField(primary_key=True, max_length=40, editable=False)
    name = models.CharField(max_length=255)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = _("Организация")
        verbose_name_plural = _("Организации")

    def __str__(self) -> str:
        return self.name

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.id:
            self.id = make_id("org")
        super().save(*args, **kwargs)  # type: ignore[arg-type]


class User(AbstractUser):
    """Пользователь системы.

    `client` и `vendor` обязаны иметь заполненную связь с контрагентом: по ней
    работает фильтрация выборки в `get_queryset()` (`BACKEND.md § 3.7`).
    Проверка непротиворечивости появится вместе с этими моделями на M3/M6.
    """

    id = models.CharField(primary_key=True, max_length=40, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.PROTECT,
        related_name="users",
        null=True,
        blank=True,
    )
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.DISPATCHER)

    locale = models.CharField(max_length=2, choices=[("ru", "ru"), ("en", "en")], default="ru")
    timezone_mode = models.CharField(
        max_length=16, choices=TimezoneMode.choices, default=TimezoneMode.UTC
    )
    timezone = models.CharField(max_length=64, default="UTC", help_text=_("Зона IANA"))

    two_factor_enabled = models.BooleanField(default=False)
    failed_login_attempts = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Пользователь")
        verbose_name_plural = _("Пользователи")

    def __str__(self) -> str:
        return f"{self.get_full_name() or self.username} ({self.get_role_display()})"

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.id:
            self.id = make_id("usr")
        super().save(*args, **kwargs)  # type: ignore[arg-type]
