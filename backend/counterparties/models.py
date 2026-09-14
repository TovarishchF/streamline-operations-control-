"""Контрагенты: клиенты, поставщики, контакты, договоры `[ТЗ 3.3]`.

Соответствие `DOMAIN.md § 3` один к одному, с поправками на реляционность:

* `PaymentTerms` — три обычные колонки, а не JSONB: по отсрочке считается
  дебиторка по срокам (`DOMAIN.md § 6`), и выборка по полю JSONB там была бы
  на порядок дороже без всякой выгоды;
* `Contact` и `VendorCertificate` — отдельные таблицы, у них своя жизнь
  (сроки действия, признак основного);
* `status` договора не хранится, а вычисляется от дат (G-42): хранимый статус
  неизбежно разъезжается с датами, потому что его некому пересчитывать
  в полночь по каждой записи.

Наименования контрагентов в демонстрационных данных вымышлены (`CLAUDE.md § 4`).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import ClassVar

from django.contrib.contenttypes.fields import GenericRelation
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils.translation import gettext_lazy as _

from accounts.models import Organization
from core.clock import now
from core.models import BaseModel

# Порог «истекает» для светофора договоров (`SPEC.md § 6.3`). Совпадает
# с самым дальним напоминанием из `Settings.contract_expiry_reminders`:
# договор попадает в жёлтую зону одновременно с первым письмом о нём.
CONTRACT_EXPIRING_DAYS = 30


class PaymentMode(models.TextChoices):
    """Способ расчётов (`DOMAIN.md § 3` PaymentTerms)."""

    PREPAYMENT = "prepayment", _("Предоплата")
    POSTPAYMENT = "postpayment", _("Постоплата")
    DEFERRED = "deferred", _("Отсрочка")


class PaymentTermsMixin(models.Model):
    """Условия расчётов. Общее для клиента, поставщика и договора."""

    payment_mode = models.CharField(
        max_length=16, choices=PaymentMode.choices, default=PaymentMode.DEFERRED
    )
    payment_defer_days = models.PositiveSmallIntegerField(
        default=0, help_text=_("0 для предоплаты и постоплаты")
    )
    payment_prepayment_percent = models.DecimalField(
        max_digits=6,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_("Доля предоплаты в процентах, только для mode=prepayment"),
    )

    class Meta:
        abstract = True


class Client(PaymentTermsMixin, BaseModel):
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

    # Кредитный лимит: сумма и валюта раздельно, как у всех денежных величин.
    # Валюта может отличаться от валюты расчётов — лимит держат в валюте,
    # в которой его согласовали.
    credit_limit_amount = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    credit_limit_currency = models.CharField(max_length=3, blank=True)

    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Клиент")
        verbose_name_plural = _("Клиенты")
        ordering = ("name",)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(credit_limit_amount__isnull=True)
                | ~models.Q(credit_limit_currency=""),
                name="client_credit_limit_has_currency",
                violation_error_message=_("У кредитного лимита обязана быть валюта"),
            ),
        )

    def __str__(self) -> str:
        return self.name


class Vendor(PaymentTermsMixin, BaseModel):
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
    # География: списки кодов ИКАО и регионов. Не выборка по элементу,
    # а признак для подбора — отдельная таблица здесь была бы лишней.
    coverage_airports = models.JSONField(default=list, blank=True)
    coverage_regions = models.JSONField(default=list, blank=True)

    # Оценка диспетчера 0..5. Входит в рейтинг (`DOMAIN.md § 7.4`) с весом 0.20
    # наряду с измеримыми составляющими, но отдельно от них: это суждение
    # человека, и смешивать его со статистикой в одном поле нельзя.
    # Целое, как объявлено в контракте: дробная «оценка на глаз» создаёт
    # видимость точности, которой у неё нет.
    manual_quality_score = models.PositiveSmallIntegerField(
        default=3, validators=[MinValueValidator(0), MaxValueValidator(5)]
    )

    # Способ обмена заявками (`INTEGRATIONS.md § 5.2`): определяет, куда
    # уходит заявка — в портал, письмом или в API поставщика.
    exchange_method = models.CharField(
        max_length=8,
        choices=[("portal", _("Портал")), ("email", _("Почта")), ("api", _("API"))],
        default="email",
    )

    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Поставщик")
        verbose_name_plural = _("Поставщики")
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name


class Contact(BaseModel):
    """Контактное лицо клиента или поставщика (`DOMAIN.md § 3` Contact).

    Ровно один владелец: контакт принадлежит либо клиенту, либо поставщику.
    Обобщённая связь здесь была бы избыточна — владельцев всего два,
    и по каждому идёт выборка.
    """

    id_prefix: ClassVar[str] = "cnt"

    client = models.ForeignKey(
        Client, on_delete=models.CASCADE, related_name="contacts", null=True, blank=True
    )
    vendor = models.ForeignKey(
        Vendor, on_delete=models.CASCADE, related_name="contacts", null=True, blank=True
    )

    name = models.CharField(max_length=255)
    role = models.CharField(max_length=128, blank=True)
    email = models.EmailField()
    phone = models.CharField(max_length=32, blank=True)
    # Язык переписки: письма поставщику уходят на его языке, а не на языке
    # отправителя (`DOMAIN.md § 9`).
    locale = models.CharField(max_length=2, choices=[("ru", "ru"), ("en", "en")], default="ru")
    is_primary = models.BooleanField(default=False)

    class Meta:
        verbose_name = _("Контактное лицо")
        verbose_name_plural = _("Контактные лица")
        ordering = ("-is_primary", "name")
        constraints = (
            models.CheckConstraint(
                condition=(
                    models.Q(client__isnull=False, vendor__isnull=True)
                    | models.Q(client__isnull=True, vendor__isnull=False)
                ),
                name="contact_has_exactly_one_owner",
                violation_error_message=_(
                    "Контакт принадлежит либо клиенту, либо поставщику, но не обоим"
                ),
            ),
        )

    def __str__(self) -> str:
        return f"{self.name} <{self.email}>"


class CertificateKind(models.TextChoices):
    IATA = "IATA", "IATA"
    ADR = "ADR", "ADR"
    ISO = "ISO", "ISO"
    OTHER = "other", _("Прочий")


class VendorCertificate(BaseModel):
    """Сертификат поставщика со сроком действия (`DOMAIN.md § 3`)."""

    id_prefix: ClassVar[str] = "crt"

    vendor = models.ForeignKey(Vendor, on_delete=models.CASCADE, related_name="certificates")
    kind = models.CharField(max_length=8, choices=CertificateKind.choices)
    number = models.CharField(max_length=64)
    valid_from = models.DateTimeField()
    valid_to = models.DateTimeField(db_index=True)

    class Meta:
        verbose_name = _("Сертификат поставщика")
        verbose_name_plural = _("Сертификаты поставщиков")
        ordering = ("valid_to",)

    def __str__(self) -> str:
        return f"{self.kind} {self.number}"


class ContractStatus(models.TextChoices):
    ACTIVE = "active", _("Действует")
    EXPIRING = "expiring", _("Истекает")
    EXPIRED = "expired", _("Истёк")
    TERMINATED = "terminated", _("Расторгнут")


class VendorContract(PaymentTermsMixin, BaseModel):
    """Договор с поставщиком `[ТЗ 3.3.3]`.

    Условия расчётов договора — снимок на момент заказа услуги
    (`CLAUDE.md § 3` п. 5): заявка копирует их себе и не смотрит сюда
    после создания.
    """

    id_prefix: ClassVar[str] = "ctr"

    vendor = models.ForeignKey(Vendor, on_delete=models.PROTECT, related_name="contracts")
    number = models.CharField(max_length=64)
    valid_from = models.DateTimeField()
    valid_to = models.DateTimeField(db_index=True)
    # Расторжение — единственное, что не выводится из дат: договор могли
    # прекратить досрочно (G-42).
    terminated_at = models.DateTimeField(null=True, blank=True)
    currency = models.CharField(max_length=3, default="RUB")

    attachments = GenericRelation(
        "core.Attachment", content_type_field="content_type", object_id_field="object_id"
    )

    class Meta:
        verbose_name = _("Договор с поставщиком")
        verbose_name_plural = _("Договоры с поставщиками")
        ordering = ("valid_to",)
        constraints = (
            models.UniqueConstraint(
                fields=("vendor", "number"), name="contract_number_unique_per_vendor"
            ),
            models.CheckConstraint(
                condition=models.Q(valid_to__gt=models.F("valid_from")),
                name="contract_valid_to_after_valid_from",
                violation_error_message=_("Дата окончания договора раньше даты начала"),
            ),
        )
        indexes = (models.Index(fields=("vendor", "valid_to")),)

    def __str__(self) -> str:
        return f"{self.number} ({self.vendor.name})"

    @property
    def status(self) -> str:
        """Светофор сроков. Вычисляется, а не хранится (G-42)."""
        if self.terminated_at is not None:
            return ContractStatus.TERMINATED
        current = now()
        if self.valid_to <= current:
            return ContractStatus.EXPIRED
        if self.valid_to - current <= timedelta(days=CONTRACT_EXPIRING_DAYS):
            return ContractStatus.EXPIRING
        return ContractStatus.ACTIVE

    def is_valid_at(self, moment: datetime) -> bool:
        """Действует ли договор на указанный момент.

        Проверка заказа услуги (`SPEC.md § 5.2` п. 2) смотрит на дату
        оказания, а не на сегодняшнюю: заказ на послезавтра по договору,
        истекающему завтра, оформлять нельзя.
        """
        if self.terminated_at is not None and self.terminated_at <= moment:
            return False
        return self.valid_from <= moment <= self.valid_to
