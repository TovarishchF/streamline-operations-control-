"""Пользователи и роли.

На M1 заводится только модель — она нужна как `AUTH_USER_MODEL` до появления
любых других таблиц. Права, 2FA, LDAP и фильтрация по арендатору — M3
(`TASKS.md`).
"""

from __future__ import annotations

from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _

from core.clock import now
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
    Непротиворечивость проверяется в `clean()` и ограничением в базе:
    портальный пользователь без контрагента видел бы всё.

    Связи заданы строками, а не импортом: `counterparties` импортирует
    `Organization` отсюда, и прямой импорт замкнул бы круг.
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

    client = models.ForeignKey(
        "counterparties.Client",
        on_delete=models.PROTECT,
        related_name="users",
        null=True,
        blank=True,
        help_text=_("Обязателен для роли «Клиент»"),
    )
    vendor = models.ForeignKey(
        "counterparties.Vendor",
        on_delete=models.PROTECT,
        related_name="users",
        null=True,
        blank=True,
        help_text=_("Обязателен для роли «Поставщик»"),
    )

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
        constraints = (
            # Портальный пользователь без контрагента не ограничен ничем:
            # фильтр выборки не находит, по чему фильтровать. Такую запись
            # не должно быть возможно создать в принципе.
            models.CheckConstraint(
                condition=(
                    ~models.Q(role="client") | models.Q(client__isnull=False)
                ),
                name="client_user_has_client",
            ),
            models.CheckConstraint(
                condition=(
                    ~models.Q(role="vendor") | models.Q(vendor__isnull=False)
                ),
                name="vendor_user_has_vendor",
            ),
        )

    def __str__(self) -> str:
        return f"{self.get_full_name() or self.username} ({self.get_role_display()})"

    def clean(self) -> None:
        super().clean()
        if self.role == Role.CLIENT and self.client_id is None:
            raise ValidationError({"client": _("Для роли «Клиент» связь с клиентом обязательна")})
        if self.role == Role.VENDOR and self.vendor_id is None:
            raise ValidationError(
                {"vendor": _("Для роли «Поставщик» связь с поставщиком обязательна")}
            )

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.id:
            self.id = make_id("usr")
        super().save(*args, **kwargs)  # type: ignore[arg-type]

    @property
    def is_locked(self) -> bool:
        return self.locked_until is not None and self.locked_until > now()


class TwoFactorDevice(models.Model):
    """Привязанное приложение-аутентификатор `[ТЗ 4.3]`.

    Секрет хранится в открытом виде: он нужен для проверки кода целиком,
    хэш здесь не работает. Защита — права на таблицу и шифрование тома
    (`INFRA.md § 6`), а не хэширование.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="two_factor")
    secret = models.CharField(max_length=64, editable=False)
    created_at = models.DateTimeField(editable=False)
    confirmed_at = models.DateTimeField(
        null=True, blank=True, help_text=_("Момент подтверждения кодом из приложения")
    )

    class Meta:
        verbose_name = _("Второй фактор")
        verbose_name_plural = _("Вторые факторы")

    def __str__(self) -> str:
        return f"2FA {self.user.username}"

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.created_at:
            self.created_at = now()
        super().save(*args, **kwargs)  # type: ignore[arg-type]


class BackupCode(models.Model):
    """Резервный код входа. Одноразовый `[ТЗ 4.3]`.

    Хранится хэш: код — это пароль, а пароли в открытом виде не лежат.
    Одноразовость обеспечена отметкой `used_at` и проверкой при входе.
    """

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="backup_codes")
    code_hash = models.CharField(max_length=128, editable=False)
    created_at = models.DateTimeField(editable=False)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Резервный код")
        verbose_name_plural = _("Резервные коды")
        indexes = (models.Index(fields=("user", "used_at")),)

    def __str__(self) -> str:
        return f"{self.user.username}: {'использован' if self.used_at else 'не использован'}"

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.created_at:
            self.created_at = now()
        super().save(*args, **kwargs)  # type: ignore[arg-type]
