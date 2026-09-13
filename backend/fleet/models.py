"""Воздушные суда и их техсостояние `[ТЗ 3.1.3]`.

`DOMAIN.md § 2`, отображение по `BACKEND.md § 4`. Состояние борта влияет
на планирование: борт в состоянии AOG нельзя назначить на рейс
(проверка появится вместе с рейсами на M4).

Допуски (ADR-027) вынесены в отдельную таблицу: у них свои сроки действия
и по ним идёт проверка пригодности борта к конкретному маршруту.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _

from catalog.models import AircraftType, icao_validator
from core.models import BaseModel
from counterparties.models import Client


class AircraftStatus(models.TextChoices):
    """ADR-009: техобслуживание и AOG разделены.

    Плановое техобслуживание известно заранее и планируется, AOG — отказ,
    который ломает расписание и требует другой реакции.
    """

    SERVICEABLE = "serviceable", _("Исправен")
    MAINTENANCE = "maintenance", _("На техобслуживании")
    AOG = "aog", _("AOG, неисправен на земле")


class Aircraft(BaseModel):
    """Борт."""

    id_prefix: ClassVar[str] = "acf"

    registration = models.CharField(
        max_length=16, unique=True, db_index=True, help_text=_("Бортовой номер, RA-67231")
    )
    type = models.ForeignKey(AircraftType, on_delete=models.PROTECT, related_name="aircraft")
    operator = models.ForeignKey(
        Client,
        on_delete=models.PROTECT,
        related_name="aircraft",
        null=True,
        blank=True,
        help_text=_("Клиент-оператор, если борт клиента"),
    )
    status = models.CharField(
        max_length=16,
        choices=AircraftStatus.choices,
        default=AircraftStatus.SERVICEABLE,
        db_index=True,
    )
    home_base_icao = models.CharField(max_length=4, validators=[icao_validator])
    notes = models.TextField(blank=True)

    class Meta:
        verbose_name = _("Воздушное судно")
        verbose_name_plural = _("Воздушные суда")
        ordering = ("registration",)

    def __str__(self) -> str:
        return f"{self.registration} ({self.type.icao_type})"


class ApprovalKind(models.TextChoices):
    ETOPS = "ETOPS", _("ETOPS")
    RVSM = "RVSM", _("RVSM")
    MNPS = "MNPS", _("MNPS")
    CAT_II = "CAT_II", _("CAT II")
    CAT_III = "CAT_III", _("CAT III")
    RNP = "RNP", _("RNP")
    OTHER = "other", _("Иной")


class AircraftApproval(BaseModel):
    """Допуск борта (ADR-027).

    Срок действия проверяется на дату рейса, а не на текущую: рейс, который
    планируется после истечения допуска, должен подсвечиваться при планировании.
    """

    id_prefix: ClassVar[str] = "apr"

    aircraft = models.ForeignKey(Aircraft, on_delete=models.CASCADE, related_name="approvals")
    kind = models.CharField(max_length=16, choices=ApprovalKind.choices)
    number = models.CharField(max_length=64, blank=True)
    valid_from = models.DateTimeField()
    valid_to = models.DateTimeField()

    class Meta:
        verbose_name = _("Допуск борта")
        verbose_name_plural = _("Допуски борта")
        ordering = ("aircraft", "kind")
        constraints = (
            models.UniqueConstraint(
                fields=("aircraft", "kind", "valid_from"), name="unique_aircraft_approval_period"
            ),
        )

    def __str__(self) -> str:
        return f"{self.aircraft.registration} — {self.kind}"
