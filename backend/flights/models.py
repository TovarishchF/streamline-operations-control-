"""Рейсы, шаблоны, заявки клиентов и слоты `[ТЗ 3.1]`.

`DOMAIN.md § 4`, автомат — `DOMAIN.md § 5.1` и `shared/state-machines/flight.json`.
Определение автомата общее с клиентом (ADR-015): расхождение автоматов между
сервером и интерфейсом — частый и дорогой баг, и файл его исключает.

Статус не присваивается напрямую (`CLAUDE.md § 3` п. 3): поле защищено
`django-fsm-2`, менять его можно только переходом через `flights.services.transitions`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _
from django_fsm import FSMField, transition

from accounts.models import Organization
from catalog.models import AircraftType, Airport, Service, icao_validator
from core.models import BaseModel
from counterparties.models import Client
from fleet.models import Aircraft
from flights.machine import transitions as machine_transitions

if TYPE_CHECKING:
    from collections.abc import Iterable

    from django.db.models import QuerySet


class FlightType(models.TextChoices):
    CHARTER = "charter", _("Чартер")
    FERRY = "ferry", _("Перегон")
    AMBULANCE = "ambulance", _("Санитарный")
    CARGO = "cargo", _("Грузовой")
    TECHNICAL = "technical", _("Технический")


class FlightStatus(models.TextChoices):
    """Состояния по `shared/state-machines/flight.json`.

    `ARRIVED` введено ADR-009: прилёт и закрытие рейса — разные события,
    между ними оформляются акты и выставляется счёт. Без разделения рейс
    либо закрывается до оформления документов, либо висит «в полёте»
    через сутки после посадки.
    """

    PLANNED = "planned", _("Запланирован")
    IN_WORK = "in_work", _("В работе")
    READY_FOR_DEPARTURE = "ready_for_departure", _("Готов к вылету")
    IN_FLIGHT = "in_flight", _("В полёте")
    ARRIVED = "arrived", _("Прилетел")
    COMPLETED = "completed", _("Завершён")
    CANCELLED = "cancelled", _("Отменён")
    AOG = "aog", _("AOG / задержка")


class ServiceLeg(models.TextChoices):
    DEPARTURE = "departure", _("Вылет")
    ARRIVAL = "arrival", _("Прилёт")


class Flight(BaseModel):
    """Рейс `[ТЗ 3.1.1]`."""

    id_prefix: ClassVar[str] = "flt"

    organization = models.ForeignKey(Organization, on_delete=models.PROTECT, related_name="flights")
    number = models.CharField(max_length=32, unique=True, db_index=True)
    client = models.ForeignKey(Client, on_delete=models.PROTECT, related_name="flights")
    aircraft = models.ForeignKey(
        Aircraft,
        on_delete=models.PROTECT,
        related_name="flights",
        null=True,
        blank=True,
        help_text=_("Может быть не назначен на момент планирования"),
    )
    type = models.CharField(max_length=16, choices=FlightType.choices, default=FlightType.CHARTER)

    dep_icao = models.CharField(max_length=4, validators=[icao_validator], db_index=True)
    arr_icao = models.CharField(max_length=4, validators=[icao_validator], db_index=True)

    std_utc = models.DateTimeField(db_index=True, help_text=_("Плановое время вылета"))
    sta_utc = models.DateTimeField(help_text=_("Плановое время прилёта"))
    atd_utc = models.DateTimeField(null=True, blank=True, help_text=_("Фактический вылет"))
    ata_utc = models.DateTimeField(null=True, blank=True, help_text=_("Фактический прилёт"))

    # Поле защищено: присвоение в обход перехода невозможно (CLAUDE.md § 3 п. 3).
    status = FSMField(
        max_length=24,
        choices=FlightStatus.choices,
        default=FlightStatus.PLANNED,
        protected=True,
        db_index=True,
    )
    status_reason_code = models.CharField(max_length=32, blank=True)
    status_reason_comment = models.TextField(blank=True)

    pax_count = models.PositiveSmallIntegerField(default=0)

    # Расчётные величины (DOMAIN.md § 7.8). Хранятся, а не считаются на лету:
    # суточный план листается постранично, и пересчёт ортодромии на каждую
    # строку при каждом открытии — лишняя работа.
    distance_nm = models.PositiveIntegerField(default=0)
    block_time_min = models.PositiveIntegerField(default=0)
    fuel_plan_kg = models.PositiveIntegerField(default=0)

    billing_currency = models.CharField(
        max_length=3, default="RUB", help_text=_("Из клиента, фиксируется при создании")
    )
    # Снимок курсов на дату рейса (CLAUDE.md § 3 п. 5): изменение справочника
    # курсов не переписывает историю рейса.
    fx_snapshot = models.JSONField(default=dict, blank=True)

    template = models.ForeignKey(
        "flights.FlightTemplate",
        on_delete=models.SET_NULL,
        related_name="flights",
        null=True,
        blank=True,
    )
    remarks = models.TextField(blank=True)

    class Meta:
        verbose_name = _("Рейс")
        verbose_name_plural = _("Рейсы")
        ordering = ("std_utc",)
        indexes = (
            models.Index(fields=("status", "std_utc")),
            models.Index(fields=("client", "std_utc")),
            models.Index(fields=("aircraft", "std_utc")),
        )

    def __str__(self) -> str:
        return f"{self.number} {self.dep_icao}→{self.arr_icao}"

    def refresh_from_db(
        self,
        using: str | None = None,
        fields: Iterable[str] | None = None,
        from_queryset: QuerySet[Any, Any] | None = None,
    ) -> None:
        """Обновление объекта из базы.

        Защищённое поле автомата запрещает присвоение, а `refresh_from_db`
        именно присваивает — без этого перечитать рейс из базы было бы
        нельзя. Снимаем закэшированное значение, чтобы обновление прошло
        штатным путём.
        """
        self.__dict__.pop("status", None)
        super().refresh_from_db(using=using, fields=fields, from_queryset=from_queryset)

    @property
    def is_international(self) -> bool:
        """Международный рейс: аэропорты в разных странах.

        Определяется по справочнику, а не по коду ИКАО: префикс кода
        совпадает с государством не всегда, и перечень исключений
        пришлось бы вести руками.
        """
        countries = set(
            Airport.objects.filter(icao__in=[self.dep_icao, self.arr_icao]).values_list(
                "country", flat=True
            )
        )
        return len(countries) > 1


class CrewMember(BaseModel):
    """Член экипажа рейса `[ТЗ 3.1.2]` (ADR-028).

    Поимённый учёт пассажиров не ведётся — хранится только количество.
    Экипаж учитывается: от квалификаций зависит допуск к рейсу.
    """

    id_prefix: ClassVar[str] = "crw"

    class Role(models.TextChoices):
        PIC = "PIC", _("Командир воздушного судна")
        SIC = "SIC", _("Второй пилот")
        FA = "FA", _("Бортпроводник")
        ENGINEER = "engineer", _("Бортинженер")

    flight = models.ForeignKey(Flight, on_delete=models.CASCADE, related_name="crew")
    name = models.CharField(max_length=255)
    role = models.CharField(max_length=16, choices=Role.choices)
    license_no = models.CharField(max_length=64, blank=True)

    class Meta:
        verbose_name = _("Член экипажа")
        verbose_name_plural = _("Экипаж")
        ordering = ("flight", "role")

    def __str__(self) -> str:
        return f"{self.name} ({self.get_role_display()})"


class FlightTemplate(BaseModel):
    """Шаблон регулярного рейса `[ТЗ 3.1.1]`.

    Время вылета задано **местным** временем аэропорта вылета: диспетчер
    договаривается о слоте в местном времени, а не в UTC. Перевод в UTC
    делается при генерации серии, и на переходе летнего времени одно и то же
    местное время даёт разное UTC — ради этого время и хранится местным.
    """

    id_prefix: ClassVar[str] = "ftp"

    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="flight_templates"
    )
    name = models.CharField(max_length=255)
    client = models.ForeignKey(Client, on_delete=models.PROTECT, related_name="flight_templates")
    aircraft_type = models.ForeignKey(
        AircraftType, on_delete=models.PROTECT, related_name="flight_templates"
    )

    dep_icao = models.CharField(max_length=4, validators=[icao_validator])
    arr_icao = models.CharField(max_length=4, validators=[icao_validator])
    dep_time_local = models.TimeField(help_text=_("Местное время аэропорта вылета"))
    # Дни недели по ISO: 1 — понедельник, 7 — воскресенье.
    weekdays = models.JSONField(default=list)

    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name = _("Шаблон рейса")
        verbose_name_plural = _("Шаблоны рейсов")
        ordering = ("name",)

    def __str__(self) -> str:
        return f"{self.name} ({self.dep_icao}→{self.arr_icao})"


class TemplateService(BaseModel):
    """Услуга, заказываемая по шаблону автоматически."""

    id_prefix: ClassVar[str] = "tsv"

    template = models.ForeignKey(
        FlightTemplate, on_delete=models.CASCADE, related_name="default_services"
    )
    service = models.ForeignKey(Service, on_delete=models.PROTECT, related_name="+")
    leg = models.CharField(max_length=16, choices=ServiceLeg.choices)
    attributes = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = _("Услуга шаблона")
        verbose_name_plural = _("Услуги шаблона")
        ordering = ("template", "leg")

    def __str__(self) -> str:
        return f"{self.template.name}: {self.service.code}"


class FlightRequestStatus(models.TextChoices):
    PENDING = "pending", _("Ожидает рассмотрения")
    APPROVED = "approved", _("Подтверждена")
    REJECTED = "rejected", _("Отклонена")


class FlightRequest(BaseModel):
    """Заявка клиента на рейс `[ТЗ 3.5.3]`.

    `SPEC § 2.2`, сноска: клиент не создаёт рейс, он подаёт заявку.
    Диспетчер её подтверждает, и только тогда появляется рейс.
    """

    id_prefix: ClassVar[str] = "frq"

    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="flight_requests"
    )
    client = models.ForeignKey(Client, on_delete=models.PROTECT, related_name="flight_requests")
    dep_icao = models.CharField(max_length=4, validators=[icao_validator])
    arr_icao = models.CharField(max_length=4, validators=[icao_validator])
    requested_std_utc = models.DateTimeField()
    pax_count = models.PositiveSmallIntegerField(default=0)
    comment = models.TextField(blank=True)

    status = models.CharField(
        max_length=16, choices=FlightRequestStatus.choices, default=FlightRequestStatus.PENDING,
        db_index=True,
    )
    rejection_reason = models.TextField(blank=True)
    flight = models.OneToOneField(
        Flight, on_delete=models.SET_NULL, related_name="request", null=True, blank=True
    )

    class Meta:
        verbose_name = _("Заявка на рейс")
        verbose_name_plural = _("Заявки на рейс")
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return f"{self.client.name}: {self.dep_icao}→{self.arr_icao}"


class SlotType(models.TextChoices):
    ARRIVAL = "arrival", _("Прилёт")
    DEPARTURE = "departure", _("Вылет")


class SlotStatus(models.TextChoices):
    REQUESTED = "requested", _("Запрошен")
    CONFIRMED = "confirmed", _("Подтверждён")
    REJECTED = "rejected", _("Отклонён")
    CANCELLED = "cancelled", _("Отменён")


class Slot(BaseModel):
    """Слот в координируемом аэропорту (ADR-026) `[ТЗ 3.1.1]`.

    Подключения к системам слот-координации не существует
    (`INTEGRATIONS § 5.1`): координаторы работают сообщениями IATA SSIM
    по почте. Здесь ведётся реестр, формирование сообщений SCR — M14.
    """

    id_prefix: ClassVar[str] = "slt"

    flight = models.ForeignKey(Flight, on_delete=models.CASCADE, related_name="slots")
    airport_icao = models.CharField(max_length=4, validators=[icao_validator])
    type = models.CharField(max_length=16, choices=SlotType.choices)
    requested_utc = models.DateTimeField()
    confirmed_utc = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=16, choices=SlotStatus.choices, default=SlotStatus.REQUESTED, db_index=True
    )
    message_number = models.CharField(max_length=64, blank=True)
    # Выдержка из ответа координатора: по ней видно, на каком основании
    # слот подтверждён или отклонён, без похода в почту.
    comment = models.TextField(blank=True)

    class Meta:
        verbose_name = _("Слот")
        verbose_name_plural = _("Слоты")
        ordering = ("requested_utc",)
        constraints = (
            models.UniqueConstraint(
                fields=("flight", "airport_icao", "type"), name="unique_slot_per_flight_leg"
            ),
        )

    def __str__(self) -> str:
        return f"{self.airport_icao} {self.get_type_display()} {self.requested_utc:%d.%m %H:%MZ}"


def _attach_transitions() -> None:
    """Вешает на `Flight` методы переходов, объявленных в автомате.

    Методы генерируются из `shared/state-machines/flight.json`, а не пишутся
    руками: список переходов в коде и в файле автомата разошёлся бы при первой
    же правке, а файл читает ещё и веб-клиент (ADR-015).

    Условия переходов здесь не проверяются — их проверяет сервисный слой
    (`flights.services.transitions`): `django-fsm` умеет возвращать только
    «нельзя», а пользователю нужен список невыполненных условий.
    """
    for item in machine_transitions():
        name = item["name"]

        def make(source: list[str], target: str) -> object:
            # Поле передаётся объектом, а не именем: строку django-fsm-2
            # принимает, но падает при переходе.
            # Декоратор не типизирован, поэтому метод приходится помечать.
            @transition(  # type: ignore[misc]
                field=Flight._meta.get_field("status"), source=source, target=target
            )
            def method(self: Flight) -> None:
                """Смена состояния. Вызывается только из сервисного слоя."""

            return method

        setattr(Flight, f"fsm_{name}", make(item["from"], item["to"]))


_attach_transitions()
