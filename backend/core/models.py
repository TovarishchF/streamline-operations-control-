"""Базовые модели.

`BaseModel` — общий предок всех доменных сущностей. Несёт четыре вещи, которые
по правилам проекта обязаны быть у каждой записи:

* ULID-идентификатор с префиксом сущности (`DOMAIN.md § 1`);
* метки создания и изменения в UTC;
* `is_demo` и `data_source` (ADR-010) — техническая очистка и честность происхождения;
* `version` для оптимистичных блокировок.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _
from ulid import ULID

from core.clock import now


class DataSource(models.TextChoices):
    """Происхождение записи (ADR-010, `CLAUDE.md § 4`).

    Данные, полученные адаптером в режиме `stub`, получают SYNTHETIC, а не LIVE.
    Заглушка не притворяется живым подключением.
    """

    SYNTHETIC = "synthetic", _("Сгенерировано")
    USER = "user", _("Введено пользователем")
    IMPORTED = "imported", _("Импортировано")
    LIVE = "live", _("Получено из внешней системы")


def make_id(prefix: str) -> str:
    """Идентификатор вида `flt_01HQ...` — префикс подсказывает тип в логах и ссылках."""
    return f"{prefix}_{ULID()}"


class BaseModel(models.Model):
    """Общий предок доменных сущностей."""

    id_prefix: ClassVar[str] = "obj"

    id = models.CharField(primary_key=True, max_length=40, editable=False)
    created_at = models.DateTimeField(editable=False, db_index=True)
    updated_at = models.DateTimeField(editable=False)

    is_demo = models.BooleanField(
        default=False,
        db_index=True,
        help_text=_("Демонстрационная запись, удаляется командой seed_demo --purge"),
    )
    data_source = models.CharField(
        max_length=16,
        choices=DataSource.choices,
        default=DataSource.USER,
        help_text=_("Происхождение данных, см. ADR-010"),
    )
    version = models.PositiveIntegerField(default=1, editable=False)

    class Meta:
        abstract = True

    def __str__(self) -> str:
        return self.id

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self.id:
            self.id = make_id(self.id_prefix)
        current = now()
        if not self.created_at:
            self.created_at = current
        self.updated_at = current
        if self.pk and not self._state.adding:
            self.version += 1
        super().save(*args, **kwargs)


class SingletonModel(models.Model):
    """Модель в единственном экземпляре."""

    class Meta:
        abstract = True

    def save(self, *args: Any, **kwargs: Any) -> None:
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise ValidationError(_("Эта настройка не удаляется"))

    @classmethod
    def get_solo(cls) -> Any:
        # _default_manager, а не objects: у абстрактной модели менеджера нет
        obj, _created = cls._default_manager.get_or_create(pk=1)
        return obj


class Settings(SingletonModel):
    """Настройки системы, влияющие на расчёты (`DOMAIN.md § 11`).

    Кэшируются в Redis; изменение сбрасывает кэш и записывается в аудит.
    """

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)

    # Финансы
    low_margin_threshold_percent = models.DecimalField(
        max_digits=6, decimal_places=4, default="12.0000"
    )
    default_markup_percent = models.DecimalField(
        max_digits=6, decimal_places=4, default="15.0000"
    )
    fx_policy = models.CharField(
        max_length=16,
        default="document_date",
        choices=[("document_date", _("На дату документа")), ("order_date", _("На дату заказа"))],
        help_text=_("payment_date исключена как нереализуемая, см. ADR-004"),
    )

    # Нумерация документов
    quote_number_mask = models.CharField(max_length=64, default="SOC-Q-{YYYY}-{NNNN}")
    invoice_number_mask = models.CharField(max_length=64, default="SOC-I-{YYYY}-{NNNN}")
    payable_number_mask = models.CharField(max_length=64, default="SOC-P-{YYYY}-{NNNN}")

    # Контракты
    contract_expiry_reminders = models.JSONField(default=list)

    # Противообледенительная обработка (ADR-029). Подсказка диспетчеру,
    # окончательное решение принимает командир воздушного судна.
    deicing_temp_with_precip_c = models.SmallIntegerField(default=3)
    deicing_temp_always_c = models.SmallIntegerField(default=0)

    # Персональные данные (G-37): срок до получения ответа заказчика
    pd_retention_months = models.PositiveSmallIntegerField(default=60)

    # Модельное время (ADR-014). Изменяется только при DEMO_DATA=true.
    clock_offset_seconds = models.IntegerField(default=0)
    clock_scale = models.PositiveSmallIntegerField(default=1)

    class Meta:
        verbose_name = _("Настройки системы")
        verbose_name_plural = _("Настройки системы")

    def __str__(self) -> str:
        return "Настройки системы"


class AttachmentKind(models.TextChoices):
    """Назначение вложения (`openapi.yaml` AttachmentRef.kind)."""

    ACT = "act", _("Акт выполненных работ")
    RECEIPT = "receipt", _("Квитанция")
    INVOICE = "invoice", _("Счёт")
    WAYBILL = "waybill", _("Накладная")
    CONTRACT = "contract", _("Договор")
    OTHER = "other", _("Прочее")


class Attachment(BaseModel):
    """Файл в объектном хранилище (ADR-007, `BACKEND.md § 8`).

    Запись заводится **до** загрузки: клиент получает подписанную ссылку,
    льёт файл прямо в S3 и подтверждает загрузку. Пока `uploaded_at` пуст,
    вложение считается незавершённым и в выдачу владельца не попадает —
    иначе оборванная загрузка оставила бы в договоре ссылку в никуда.

    Владелец — обобщённая связь: договор, заявка на услугу и счёт носят
    вложения одного вида, и три почти одинаковые таблицы отличались бы
    только именем колонки.
    """

    id_prefix: ClassVar[str] = "att"

    file_name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=128)
    size_bytes = models.PositiveIntegerField()
    kind = models.CharField(
        max_length=16, choices=AttachmentKind.choices, default=AttachmentKind.OTHER
    )
    # Ключ в бакете. Уникален: два вложения не могут указывать на один объект,
    # иначе удаление одного оборвёт второе.
    storage_key = models.CharField(max_length=512, unique=True)

    uploaded_at = models.DateTimeField(null=True, blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="attachments",
    )

    content_type = models.ForeignKey(
        ContentType, on_delete=models.CASCADE, null=True, blank=True
    )
    object_id = models.CharField(max_length=40, blank=True, db_index=True)
    owner = GenericForeignKey("content_type", "object_id")

    class Meta:
        verbose_name = _("Вложение")
        verbose_name_plural = _("Вложения")
        ordering = ("-created_at",)
        indexes = (models.Index(fields=("content_type", "object_id")),)

    def __str__(self) -> str:
        return self.file_name
