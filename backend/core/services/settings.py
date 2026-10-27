"""Настройки системы, влияющие на расчёты (`DOMAIN.md § 11`).

Чтение и правка — в форме `Settings` контракта. Правка пишется в аудит
с разницей «было/стало» и сбрасывает расчёты, которые от настроек
зависят (кэш маржи: порог и наценка по умолчанию).

Модельное время (ADR-014) меняется только при `SAMPLE_DATA=true`: в рабочей
системе перемотка часов означала бы задним числом переписанные сроки SLA
и автопереходы рейсов. При каждой перемотке или смене ускорения якорь
переставляется на настоящий момент: смена ускорения не теряет накопленное
смещение. Смещение 0 при ускорении ×1 возвращает настоящее время.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, ClassVar

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType
from core import clock, sample_data
from core.exceptions import DomainError, SampleDataDisabled
from core.models import Settings

if TYPE_CHECKING:
    from accounts.models import User

CLOCK_SCALES = (1, 60, 600)
SLA_WEIGHT_KEYS = ("onTimeConfirm", "slaCompliance", "billing", "quality")
SUGGEST_WEIGHT_KEYS = ("price", "rating", "proximity")
MAX_REMINDER_DAYS = 365
MAX_RETENTION_MONTHS = 600
MAX_MARKUP_PERCENT = Decimal(1000)
DEICING_RANGE = range(-30, 11)
# Длина поля маски в модели.
MAX_MASK_LENGTH = 64


class SettingsInvalid(DomainError):
    """Значение настройки вне допустимого."""

    code = "VALIDATION_ERROR"
    http_status: ClassVar[int] = 400


def to_contract(current: Settings) -> dict[str, Any]:
    """Форма `Settings` контракта."""
    return {
        "lowMarginThresholdPercent": str(Decimal(str(current.low_margin_threshold_percent))),
        "defaultMarkupPercent": str(Decimal(str(current.default_markup_percent))),
        "documentNumberMasks": {
            "quote": current.quote_number_mask,
            "invoice": current.invoice_number_mask,
            "payable": current.payable_number_mask,
        },
        "fxPolicy": current.fx_policy,
        "slaWeights": dict(current.sla_weights or {}),
        "vendorSuggestWeights": dict(current.vendor_suggest_weights or {}),
        "contractExpiryReminders": list(current.contract_expiry_reminders or []),
        "deicingRule": {
            "tempWithPrecipC": current.deicing_temp_with_precip_c,
            "tempAlwaysC": current.deicing_temp_always_c,
        },
        "pdRetentionMonths": current.pd_retention_months,
        # Накопленное смещение на этот момент, с учётом ускорения: клиент
        # прибавляет к нему перемотку и присылает обратно.
        "clockOffsetSeconds": int((clock.now() - clock.real_now()).total_seconds()),
        "clockScale": current.clock_scale,
        "sampleData": sample_data.enabled(),
    }


def _decimal(value: Any, field: str, *, low: Decimal, high: Decimal) -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise SettingsInvalid(f"{field}: ожидается десятичное число", {"field": field}) from None
    if not number.is_finite() or number < low or number > high:
        raise SettingsInvalid(f"{field}: допустимо от {low} до {high}", {"field": field})
    return number


def _weights(value: Any, field: str, keys: tuple[str, ...]) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - set(keys):
        raise SettingsInvalid(f"{field}: допустимые веса — {', '.join(keys)}", {"field": field})
    cleaned = {
        key: str(_decimal(value.get(key, "0"), f"{field}.{key}", low=Decimal(0), high=Decimal(1)))
        for key in keys
    }
    if sum(Decimal(item) for item in cleaned.values()) <= 0:
        raise SettingsInvalid(f"{field}: хотя бы один вес больше нуля", {"field": field})
    return cleaned


def _mask(value: Any, field: str) -> str:
    """Маска номера обязана нести и год, и порядковый номер.

    Счётчик начинается заново каждый год: без года в маске номер первого
    счёта следующего года совпал бы с номером первого счёта этого.
    """
    mask = str(value or "").strip()
    if "{YYYY}" not in mask or "{NNNN}" not in mask or len(mask) > MAX_MASK_LENGTH:
        raise SettingsInvalid(
            f"{field}: маска обязана содержать {{YYYY}} и {{NNNN}}", {"field": field}
        )
    return mask


@transaction.atomic
def update(*, changes: dict[str, Any], actor: User) -> Settings:
    """Правка настроек. Модельное время — только при включённом генераторе."""
    current = Settings.objects.select_for_update().get(pk=Settings.get_solo().pk)
    before = audit.snapshot(current)

    if "clockOffsetSeconds" in changes or "clockScale" in changes:
        if not sample_data.enabled():
            raise SampleDataDisabled(
                "Модельное время меняется только при SAMPLE_DATA=true: в рабочей системе "
                "перемотка часов переписала бы сроки SLA и автопереходы (ADR-014)"
            )
        _apply_clock(current, changes)
    _apply_finance(current, changes)
    _apply_weights(current, changes)
    _apply_reference(current, changes)

    current.save()
    # Ответ — значения из базы, а не только что присвоенные: «15» и «15.0000»
    # — одно число, но клиент должен видеть то, что хранится.
    current.refresh_from_db()
    audit.record(
        entity_type=AuditEntityType.SETTINGS,
        entity_id=str(current.pk),
        action="updated",
        actor=actor,
        before=before,
        after=audit.snapshot(current),
    )

    # Порог, наценка и веса участвуют в марже и подборе: прежний расчёт
    # в кэше больше не верен.
    from billing.services import margin

    transaction.on_commit(margin.invalidate_all)
    return current


def _apply_finance(current: Settings, changes: dict[str, Any]) -> None:
    if "lowMarginThresholdPercent" in changes:
        current.low_margin_threshold_percent = _decimal(
            changes["lowMarginThresholdPercent"],
            "lowMarginThresholdPercent",
            low=Decimal(-100),
            high=Decimal(100),
        )
    if "defaultMarkupPercent" in changes:
        current.default_markup_percent = _decimal(
            changes["defaultMarkupPercent"],
            "defaultMarkupPercent",
            low=Decimal(0),
            high=MAX_MARKUP_PERCENT,
        )
    if "documentNumberMasks" in changes:
        masks = changes["documentNumberMasks"] or {}
        for key, field in (
            ("quote", "quote_number_mask"),
            ("invoice", "invoice_number_mask"),
            ("payable", "payable_number_mask"),
        ):
            if key in masks:
                setattr(current, field, _mask(masks[key], f"documentNumberMasks.{key}"))
    if "fxPolicy" in changes:
        if changes["fxPolicy"] not in ("document_date", "order_date"):
            raise SettingsInvalid("fxPolicy: document_date или order_date", {"field": "fxPolicy"})
        current.fx_policy = changes["fxPolicy"]


def _apply_weights(current: Settings, changes: dict[str, Any]) -> None:
    if "slaWeights" in changes:
        current.sla_weights = _weights(changes["slaWeights"], "slaWeights", SLA_WEIGHT_KEYS)
    if "vendorSuggestWeights" in changes:
        current.vendor_suggest_weights = _weights(
            changes["vendorSuggestWeights"], "vendorSuggestWeights", SUGGEST_WEIGHT_KEYS
        )


def _apply_reference(current: Settings, changes: dict[str, Any]) -> None:
    if "contractExpiryReminders" in changes:
        raw = changes["contractExpiryReminders"]
        if (
            not isinstance(raw, list)
            or not raw
            or not all(
                isinstance(day, int) and not isinstance(day, bool) and 0 < day <= MAX_REMINDER_DAYS
                for day in raw
            )
        ):
            raise SettingsInvalid(
                f"contractExpiryReminders: дни от 1 до {MAX_REMINDER_DAYS}",
                {"field": "contractExpiryReminders"},
            )
        current.contract_expiry_reminders = sorted(set(raw), reverse=True)
    if "deicingRule" in changes:
        rule = changes["deicingRule"] or {}
        for key, field in (
            ("tempWithPrecipC", "deicing_temp_with_precip_c"),
            ("tempAlwaysC", "deicing_temp_always_c"),
        ):
            if key in rule:
                if not isinstance(rule[key], int) or rule[key] not in DEICING_RANGE:
                    raise SettingsInvalid(
                        f"deicingRule.{key}: от −30 до +10 °C", {"field": f"deicingRule.{key}"}
                    )
                setattr(current, field, rule[key])
    if "pdRetentionMonths" in changes:
        months = changes["pdRetentionMonths"]
        if not isinstance(months, int) or not 0 < months <= MAX_RETENTION_MONTHS:
            raise SettingsInvalid(
                f"pdRetentionMonths: от 1 до {MAX_RETENTION_MONTHS}",
                {"field": "pdRetentionMonths"},
            )
        current.pd_retention_months = months


def _apply_clock(current: Settings, changes: dict[str, Any]) -> None:
    """Перемотка и ускорение с переносом якоря на настоящий момент."""
    real = clock.real_now()
    accumulated = clock.now() - real
    if "clockOffsetSeconds" in changes:
        value = changes["clockOffsetSeconds"]
        if not isinstance(value, int) or isinstance(value, bool):
            raise SettingsInvalid(
                "clockOffsetSeconds: целое число секунд", {"field": "clockOffsetSeconds"}
            )
        accumulated = timedelta(seconds=value)
    if "clockScale" in changes:
        if changes["clockScale"] not in CLOCK_SCALES:
            raise SettingsInvalid("clockScale: 1, 60 или 600", {"field": "clockScale"})
        current.clock_scale = changes["clockScale"]
    current.clock_offset_seconds = int(accumulated.total_seconds())
    current.clock_anchor_at = real
