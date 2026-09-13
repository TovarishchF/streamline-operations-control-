"""Справочники: аэропорты, типы воздушных судов, услуги, ставки НДС.

Отображение из `DOMAIN.md § 2` по таблице `BACKEND.md § 4`. Наполняются
командой `seed_reference` из `shared/reference/` — это общедоступные
справочные данные, и они реальны (`CLAUDE.md § 4`), в отличие от наименований
клиентов и поставщиков.

Наименования хранятся двумя полями (ADR-031), а не ключом перевода: справочник
редактируется администратором, а не переводчиком, и значения приходят из
внешних источников уже на двух языках.
"""

from __future__ import annotations

from typing import ClassVar

from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import BaseModel

icao_validator = RegexValidator(r"^[A-Z]{4}$", _("Код ИКАО — четыре заглавные латинские буквы"))


class Airport(BaseModel):
    """Аэропорт. `ТЗ 3.1.1` — основа расчёта маршрута и локального времени."""

    id_prefix: ClassVar[str] = "apt"

    icao = models.CharField(max_length=4, unique=True, validators=[icao_validator], db_index=True)
    iata = models.CharField(max_length=3, blank=True, db_index=True)

    name_ru = models.CharField(max_length=255)
    name_en = models.CharField(max_length=255)
    city_ru = models.CharField(max_length=255, blank=True)
    city_en = models.CharField(max_length=255, blank=True)

    country = models.CharField(max_length=2, help_text=_("ISO 3166-1 alpha-2"))
    timezone = models.CharField(max_length=64, help_text=_("Зона IANA, например Europe/Moscow"))

    lat = models.FloatField(validators=[MinValueValidator(-90.0), MaxValueValidator(90.0)])
    lon = models.FloatField(validators=[MinValueValidator(-180.0), MaxValueValidator(180.0)])
    elevation_ft = models.IntegerField(default=0)

    # ADR-026: перечень координируемых аэропортов заказчик ещё не передал (G-34),
    # поэтому признак редактируется, а проверка слота — мягкая.
    is_coordinated = models.BooleanField(
        default=False, help_text=_("Аэропорт слот-координируется, IATA Level 3")
    )

    class Meta:
        verbose_name = _("Аэропорт")
        verbose_name_plural = _("Аэропорты")
        ordering = ("icao",)
        indexes = (models.Index(fields=("country",)),)

    def __str__(self) -> str:
        return f"{self.icao} — {self.name_ru}"


class AircraftCategory(models.TextChoices):
    LIGHT = "light", _("Лёгкий")
    MIDSIZE = "midsize", _("Средний")
    HEAVY = "heavy", _("Тяжёлый")
    AIRLINER = "airliner", _("Магистральный")
    CARGO = "cargo", _("Грузовой")


class AircraftType(BaseModel):
    """Тип воздушного судна. Обозначение — ICAO Doc 8643."""

    id_prefix: ClassVar[str] = "act"

    icao_type = models.CharField(max_length=4, unique=True, db_index=True)
    name_ru = models.CharField(max_length=255)
    name_en = models.CharField(max_length=255)
    category = models.CharField(max_length=16, choices=AircraftCategory.choices)

    seats = models.PositiveSmallIntegerField(default=0)
    cruise_speed_kts = models.PositiveSmallIntegerField(
        help_text=_("Крейсерская скорость, узлы. Оценка времени в пути — DOMAIN.md § 7.8")
    )
    fuel_burn_kg_per_hour = models.PositiveIntegerField(default=0)
    turnaround_min = models.PositiveSmallIntegerField(
        default=60, help_text=_("Минимальный интервал между рейсами борта, поиск конфликтов")
    )

    class Meta:
        verbose_name = _("Тип воздушного судна")
        verbose_name_plural = _("Типы воздушных судов")
        ordering = ("icao_type",)

    def __str__(self) -> str:
        return f"{self.icao_type} — {self.name_ru}"


class ServiceCategory(models.TextChoices):
    """Категории строго по ТЗ 3.2.1. Седьмой без изменения ТЗ быть не может."""

    FUEL = "fuel", _("Топливообеспечение")
    HANDLING = "handling", _("Наземное обслуживание")
    CATERING = "catering", _("Кейтеринг")
    TRANSPORT = "transport", _("Транспорт")
    PERMITS = "permits", _("Разрешительные документы")
    DEICING = "deicing", _("Противообледенительная обработка")


class ServiceUnit(models.TextChoices):
    LITRE = "L", _("литр")
    KILOGRAM = "kg", _("килограмм")
    PIECE = "ea", _("штука")
    HOUR = "hour", _("час")
    PASSENGER = "pax", _("пассажир")
    FLIGHT = "flight", _("рейс")


class Service(BaseModel):
    """Позиция каталога услуг `[ТЗ 3.2.1]`."""

    id_prefix: ClassVar[str] = "svc"

    code = models.CharField(max_length=32, unique=True, db_index=True)
    category = models.CharField(max_length=16, choices=ServiceCategory.choices, db_index=True)
    name_ru = models.CharField(max_length=255)
    name_en = models.CharField(max_length=255)
    unit = models.CharField(max_length=8, choices=ServiceUnit.choices)

    requires_weather = models.BooleanField(
        default=False, help_text=_("При заказе подтягивается METAR/TAF, ADR-029")
    )
    lead_time_h = models.PositiveSmallIntegerField(
        default=0, help_text=_("Минимальный срок подачи заявки, часы. Проверка мягкая")
    )
    requires_act_to_complete = models.BooleanField(
        default=False, help_text=_("Заявка не закрывается без приложенного акта")
    )
    # Схема обязательных атрибутов заявки: список ServiceAttributeDef.
    # JSONB, потому что набор полей у каждой услуги свой и по нему не ищут.
    required_attributes = models.JSONField(default=list, blank=True)

    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Услуга")
        verbose_name_plural = _("Каталог услуг")
        ordering = ("category", "code")

    def __str__(self) -> str:
        return f"{self.code} — {self.name_ru}"


class VatApplicability(models.TextChoices):
    DOMESTIC = "domestic", _("Внутри РФ")
    INTERNATIONAL = "international", _("Международная перевозка")
    EXPORT_OF_SERVICES = "export_of_services", _("Место реализации вне РФ")
    EXEMPT = "exempt", _("Освобождено от НДС")


class VatRate(BaseModel):
    """Ставка НДС `[ТЗ 3.4.1]`.

    Процент — `Decimal`: число с плавающей точкой в расчётах запрещено
    (`CLAUDE.md § 3` п. 1). Ставка копируется снимком в строку документа,
    изменение справочника не переписывает выставленные счета (§ 3 п. 5).
    """

    id_prefix: ClassVar[str] = "vat"

    code = models.CharField(max_length=32, unique=True, db_index=True)
    name_ru = models.CharField(max_length=255)
    name_en = models.CharField(max_length=255)
    percent = models.DecimalField(max_digits=6, decimal_places=4)
    applicability = models.CharField(max_length=24, choices=VatApplicability.choices)
    legal_basis = models.CharField(max_length=255, blank=True, help_text=_("Норма НК РФ"))
    note = models.TextField(blank=True)

    class Meta:
        verbose_name = _("Ставка НДС")
        verbose_name_plural = _("Ставки НДС")
        ordering = ("-percent", "code")

    def __str__(self) -> str:
        return f"{self.code} ({self.percent} %)"
