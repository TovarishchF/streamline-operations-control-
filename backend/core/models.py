"""Базовые модели.

`BaseModel` — общий предок всех доменных сущностей. Несёт четыре вещи, которые
по правилам проекта обязаны быть у каждой записи:

* ULID-идентификатор с префиксом сущности (`DOMAIN.md § 1`);
* метки создания и изменения в UTC;
* `is_generated` и `data_source` (ADR-010) — техническая очистка и честность происхождения;
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
from core.sample_data import is_generating


class DataSource(models.TextChoices):
    """Происхождение записи (ADR-010, `CLAUDE.md § 4`).

    SYNTHETIC — генератор данных; LIVE — ответ внешней системы, полученный
    её адаптером. Заглушек, которые выдавали бы придуманное за ответ внешней
    системы, нет (ADR-039).
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

    is_generated = models.BooleanField(
        default=False,
        db_index=True,
        help_text=_("Запись генератора данных, удаляется командой seed_sample --purge"),
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
        if self._state.adding and is_generating():
            # Запись, созданная генератором через общий сервис, — тоже
            # запись генератора (`core.sample_data.generating`).
            self.is_generated = True
            self.data_source = DataSource.SYNTHETIC
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


def default_contract_expiry_reminders() -> list[int]:
    """Пороги напоминаний об истечении договора, дни (`SPEC.md § 6.3`)."""
    return [30, 15, 7]


def default_sla_weights() -> dict[str, str]:
    """Веса составляющих рейтинга поставщика (`DOMAIN.md § 7.4`)."""
    return {"onTimeConfirm": "0.30", "slaCompliance": "0.30", "billing": "0.20", "quality": "0.20"}


def default_vendor_suggest_weights() -> dict[str, str]:
    """Веса подбора поставщика по умолчанию — пресет «сбалансированный» (`DOMAIN.md § 7.5`)."""
    return {"price": "0.50", "rating": "0.30", "proximity": "0.20"}


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
    # Номер сообщения координатору слота (ADR-026): на него ссылается
    # ответ координатора, и по нему ответ связывается с запросом.
    slot_message_mask = models.CharField(max_length=64, default="SCR-{YYYY}-{NNNN}")

    # Контракты
    contract_expiry_reminders = models.JSONField(default=default_contract_expiry_reminders)

    # Веса хранятся десятичными строками, а не числами: в JSON число
    # с плавающей точкой, а веса умножаются на доли в `Decimal`
    # (`CLAUDE.md § 3` п. 1).
    sla_weights = models.JSONField(default=default_sla_weights)
    vendor_suggest_weights = models.JSONField(default=default_vendor_suggest_weights)

    # Противообледенительная обработка (ADR-029). Подсказка диспетчеру,
    # окончательное решение принимает командир воздушного судна.
    deicing_temp_with_precip_c = models.SmallIntegerField(default=3)
    deicing_temp_always_c = models.SmallIntegerField(default=0)

    # Персональные данные (G-37): срок до получения ответа заказчика
    pd_retention_months = models.PositiveSmallIntegerField(default=60)

    # Модельное время (ADR-014). Изменяется только при SAMPLE_DATA=true.
    # Модельный момент = настоящий + смещение + (масштаб − 1) × время,
    # прошедшее с якоря: при ускорении ×60 час проходит за минуту.
    # При каждой смене масштаба или перемотке якорь переставляется
    # на настоящий момент, а смещение — на накопленное к нему.
    clock_offset_seconds = models.IntegerField(default=0)
    clock_scale = models.PositiveSmallIntegerField(default=1)
    clock_anchor_at = models.DateTimeField(null=True, blank=True)

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


class PerformanceSource(models.TextChoices):
    SERVER = "server", _("Сервер")
    CLIENT = "client", _("Клиент")


class PerformanceSample(models.Model):
    """Замер производительности `[ТЗ 4.4]` (ADR-017).

    Серверный — время ответа эндпоинта, записанное посредником; клиентский —
    время от навигации до отрисовки экрана, присланное веб-клиентом.
    `/admin/performance` показывает перцентили по этим замерам, а не
    декларацию. Время — настоящее, не модельное: замер о реальном моменте
    (`core.clock.real_now`).

    Не наследует `BaseModel`: у замера нет ни происхождения данных,
    ни версии, а таблица пишется на каждый запрос к карточке рейса —
    лишние колонки здесь только место.
    """

    name = models.CharField(max_length=32)
    source = models.CharField(max_length=8, choices=PerformanceSource.choices)
    duration_ms = models.PositiveIntegerField()
    recorded_at = models.DateTimeField(db_index=True)
    route = models.CharField(max_length=255, blank=True)
    kind = models.CharField(max_length=16, blank=True)

    class Meta:
        verbose_name = _("Замер производительности")
        verbose_name_plural = _("Замеры производительности")
        indexes = (models.Index(fields=("name", "source", "recorded_at")),)

    def __str__(self) -> str:
        return f"{self.source}:{self.name} {self.duration_ms} мс"
