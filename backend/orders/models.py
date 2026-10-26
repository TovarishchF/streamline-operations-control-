"""Заявки на услуги `[ТЗ 3.2.2, 3.2.3]`.

Соответствие `DOMAIN.md § 4` с поправками на реляционность: снимки цены
и условий контракта — обычные поля, а не связи на прайс и договор
(`BACKEND.md § 3.6`). Это не оптимизация, а требование: изменение прайса
не должно переписывать суммы в уже оформленных заявках, и проверяется
это тестом.

Фактические время и количество (ADR-020) отделены от плановых: в счёт идёт
факт, а не план. Для топлива они расходятся на каждом рейсе.

Методы переходов генерируются из `shared/state-machines/service-order.json`,
а не пишутся руками: тот же файл читает веб-клиент (ADR-015).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from django.conf import settings
from django.contrib.contenttypes.fields import GenericRelation
from django.db import models
from django.utils.translation import gettext_lazy as _
from django_fsm import FSMField, transition

from catalog.models import Service, ServiceCategory, icao_validator
from core.models import BaseModel
from counterparties.models import Vendor, VendorContract
from flights.models import Flight, ServiceLeg

if TYPE_CHECKING:
    from collections.abc import Iterable

    from django.db.models import QuerySet

MACHINE_PATH = Path(settings.SHARED_DIR) / "state-machines" / "service-order.json"


@lru_cache(maxsize=1)
def machine_definition() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(MACHINE_PATH.read_text(encoding="utf-8"))
    return payload


def machine_transitions() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = machine_definition()["transitions"]
    return items


class ServiceOrderStatus(models.TextChoices):
    """Состояния по `shared/state-machines/service-order.json`."""

    DRAFT = "draft", _("Черновик")
    ORDERED = "ordered", _("Заказана")
    CONFIRMED = "confirmed", _("Подтверждена")
    IN_PROGRESS = "in_progress", _("Выполняется")
    COMPLETED = "completed", _("Выполнена")
    REJECTED = "rejected", _("Отклонена")
    CANCELLED = "cancelled", _("Отменена")


class ServiceOrder(BaseModel):
    """Заявка на услугу у поставщика."""

    id_prefix: ClassVar[str] = "ord"

    flight = models.ForeignKey(Flight, on_delete=models.CASCADE, related_name="service_orders")
    service = models.ForeignKey(Service, on_delete=models.PROTECT, related_name="orders")
    leg = models.CharField(max_length=16, choices=ServiceLeg.choices)
    # Выводится из плеча и рейса, но хранится: аэропорт вылета рейса можно
    # изменить, а заявка уже ушла поставщику в конкретный аэропорт.
    airport_icao = models.CharField(max_length=4, validators=[icao_validator])

    vendor = models.ForeignKey(
        Vendor, on_delete=models.PROTECT, related_name="orders", null=True, blank=True
    )
    # Договор, по которому оформлена заявка. Ссылка нужна для сверки
    # и претензий; условия при этом скопированы в снимок ниже.
    contract = models.ForeignKey(
        VendorContract, on_delete=models.PROTECT, related_name="orders", null=True, blank=True
    )

    status = FSMField(
        max_length=16,
        choices=ServiceOrderStatus.choices,
        default=ServiceOrderStatus.DRAFT,
        protected=True,
        db_index=True,
    )

    quantity = models.DecimalField(max_digits=18, decimal_places=4, default=1)
    # Фактическое количество идёт в счёт (ADR-020). `null` означает
    # «ещё не зафиксировано», а не «ноль».
    actual_quantity = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    attributes = models.JSONField(default=dict, blank=True)

    # ─────────── Снимки на момент назначения (`CLAUDE.md § 3` п. 5) ───────────

    purchase_unit_amount = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    purchase_currency = models.CharField(max_length=3, blank=True)
    purchase_min_charge_amount = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    purchase_surcharges = models.JSONField(default=list, blank=True)
    # Итог по формуле `DOMAIN.md § 7.1`, посчитанный на момент заказа.
    purchase_cost_amount = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    # Фактическая цена за единицу, если поставщик выставил иную. Расхождение
    # с `purchase_unit_amount` — предмет сверки (`DOMAIN.md § 7.7`).
    actual_purchase_unit_amount = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )
    # Снимок условий расчётов договора (ADR-025): валюта, способ, отсрочка.
    contract_terms_snapshot = models.JSONField(default=dict, blank=True)

    # ─────────────────────────── Время ───────────────────────────

    ordered_at = models.DateTimeField(null=True, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    # Фактическое время оказания вводится вручную и именно оно идёт
    # в биллинг `[ТЗ 3.2.3]`.
    actual_start_at = models.DateTimeField(null=True, blank=True)
    actual_end_at = models.DateTimeField(null=True, blank=True)

    # ─────────────────────────── SLA ───────────────────────────

    sla_confirm_deadline = models.DateTimeField(null=True, blank=True, db_index=True)
    sla_breached = models.BooleanField(default=False, db_index=True)
    # Срок исполнения (`DOMAIN.md § 7.6`): плановое время услуги плюс
    # норматив правила. Фиксируется при заказе, как и срок подтверждения:
    # правило могут поменять, а заявка принята на прежних условиях.
    sla_completion_deadline = models.DateTimeField(null=True, blank=True)
    # Нарушение срока исполнения отмечается при переходе в «Выполнена»
    # по фактическому окончанию. Отдельно от `sla_breached`: опоздать
    # с ответом и опоздать с работой — разные нарушения, и в рейтинге
    # (`DOMAIN.md § 7.4`) они учитываются разными составляющими.
    sla_completion_breached = models.BooleanField(default=False)

    rejection_reason = models.TextField(blank=True)
    # Заявка, взамен которой создана эта. Заполняется при переназначении
    # после отказа поставщика `[ТЗ 3.3.2]`.
    replaced_order = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="replacements"
    )
    # Нарушение лидтайма подтверждается с причиной, причина идёт в аудит
    # (`SPEC.md § 5.2`).
    override_reason = models.TextField(blank=True)

    documents = GenericRelation(
        "core.Attachment", content_type_field="content_type", object_id_field="object_id"
    )

    class Meta:
        verbose_name = _("Заявка на услугу")
        verbose_name_plural = _("Заявки на услуги")
        ordering = ("flight", "leg", "created_at")
        indexes = (
            models.Index(fields=("flight",)),
            models.Index(fields=("vendor", "status")),
            # Частичный индекс по неподтверждённым: фоновая задача SLA
            # ходит только по ним, а их доля мала (`BACKEND.md § 4`).
            models.Index(
                fields=("sla_confirm_deadline",),
                name="order_sla_pending_idx",
                condition=models.Q(status="ordered"),
            ),
        )

    def __str__(self) -> str:
        return f"{self.flight.number}: {self.service.code} ({self.get_status_display()})"

    def refresh_from_db(
        self,
        using: str | None = None,
        fields: Iterable[str] | None = None,
        from_queryset: QuerySet[Any, Any] | None = None,
    ) -> None:
        """Обновление объекта из базы.

        Защищённое поле автомата запрещает присвоение, а `refresh_from_db`
        именно присваивает — та же поправка, что у рейса. Снимаем
        закэшированное значение, чтобы обновление прошло штатным путём.
        """
        self.__dict__.pop("status", None)
        super().refresh_from_db(using=using, fields=fields, from_queryset=from_queryset)


class SlaPenaltyKind(models.TextChoices):
    """Штраф за нарушение (`DOMAIN.md § 7.6`). По умолчанию отключён (G-39)."""

    NONE = "none", _("Без штрафа")
    FIXED = "fixed", _("Фиксированная сумма")
    PERCENT = "percent", _("Процент от стоимости услуги")


class SlaRule(BaseModel):
    """Правило SLA `[ТЗ 3.2.3]` (`DOMAIN.md § 7.6`, G-39).

    Область действия — категория услуги, поставщик, оба сразу или ничего
    (значение по умолчанию). Выбирается самое специфичное правило:
    поставщик и категория → поставщик → категория → умолчание. Поставщик
    специфичнее категории: его сроки записаны в договоре с ним, а сроки
    категории — общая норма.

    Правило не редактируется и не удаляется: новое правило на ту же
    область вытесняет прежнее, а прежнее остаётся с отметкой
    `superseded_at`. Сроки в уже оформленных заявках зафиксированы при
    заказе и от правки справочника не меняются (`CLAUDE.md § 3` п. 5),
    но историю справочника видно.
    """

    id_prefix: ClassVar[str] = "sla"

    category = models.CharField(max_length=16, choices=ServiceCategory.choices, blank=True)
    vendor = models.ForeignKey(
        Vendor, on_delete=models.PROTECT, related_name="sla_rules", null=True, blank=True
    )

    confirm_minutes = models.PositiveIntegerField()
    completion_minutes = models.PositiveIntegerField(null=True, blank=True)

    penalty_kind = models.CharField(
        max_length=8, choices=SlaPenaltyKind.choices, default=SlaPenaltyKind.NONE
    )
    # Фиксированный штраф — в валюте стоимости услуги, процент — от неё же:
    # у штрафа по заявке нет собственной валюты, он считается к её сумме.
    penalty_value = models.DecimalField(max_digits=18, decimal_places=4, null=True, blank=True)

    superseded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Правило SLA")
        verbose_name_plural = _("Правила SLA")
        ordering = ("vendor", "category", "-created_at")
        constraints = (
            # На одну область — одно действующее правило. Пустой поставщик
            # считается значением, а не «неизвестно»: иначе два правила
            # по умолчанию на одну категорию база пропустила бы.
            models.UniqueConstraint(
                fields=("category", "vendor"),
                condition=models.Q(superseded_at__isnull=True),
                nulls_distinct=False,
                name="sla_rule_one_active_per_scope",
            ),
            models.CheckConstraint(
                condition=models.Q(confirm_minutes__gt=0),
                name="sla_rule_confirm_minutes_positive",
                violation_error_message=_("Срок подтверждения должен быть больше нуля"),
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(penalty_kind="none", penalty_value__isnull=True)
                    | (~models.Q(penalty_kind="none") & models.Q(penalty_value__gt=0))
                ),
                name="sla_rule_penalty_consistent",
                violation_error_message=_("У штрафа обязан быть размер больше нуля"),
            ),
        )

    def __str__(self) -> str:
        return f"SLA {self.vendor_id or '*'} / {self.category or '*'}: {self.confirm_minutes} мин"

    @property
    def specificity(self) -> int:
        """Чем уже область, тем выше: поставщик весит больше категории."""
        return (2 if self.vendor_id else 0) + (1 if self.category else 0)


def _attach_transitions() -> None:
    """Объявляет методы переходов `fsm_<name>` по определению автомата.

    Условия переходов здесь не проверяются — их проверяет сервисный слой
    (`orders.services.transitions`): `django-fsm` умеет вернуть только
    «нельзя», а пользователю нужен список невыполненных условий.
    """
    for item in machine_transitions():
        name = item["name"]

        def make(source: list[str], target: str) -> object:
            # Поле передаётся объектом, а не именем: строку django-fsm-2
            # принимает, но падает при переходе.
            @transition(  # type: ignore[misc]
                field=ServiceOrder._meta.get_field("status"), source=source, target=target
            )
            def method(self: ServiceOrder) -> None:
                """Смена состояния. Вызывается только из сервисного слоя."""

            return method

        setattr(ServiceOrder, f"fsm_{name}", make(item["from"], item["to"]))


_attach_transitions()
