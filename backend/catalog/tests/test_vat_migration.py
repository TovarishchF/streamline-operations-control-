"""Переход на базовую ставку НДС 22 % в уже заполненной базе (миграция 0005)."""

from __future__ import annotations

import importlib
from decimal import Decimal

import pytest
from django.apps import apps

from catalog.models import VatRate
from core.models import DataSource

migration = importlib.import_module("catalog.migrations.0005_vat_base_rate_22")


def _rate(code: str, percent: str) -> VatRate:
    return VatRate.objects.create(
        code=code,
        name_ru=f"НДС {percent} %",
        name_en=f"VAT {percent}%",
        percent=Decimal(percent),
        applicability="domestic",
        data_source=DataSource.IMPORTED,
    )


@pytest.mark.django_db
def test_base_rate_becomes_22_percent_in_place() -> None:
    """Строки документов ссылаются на ту же запись и после перехода."""
    old = _rate("VAT20", "20")

    migration.forward(apps, None)

    rate = VatRate.objects.get(pk=old.pk)
    assert (rate.code, rate.percent, rate.name_ru) == ("VAT22", Decimal("22.0000"), "НДС 22 %")


@pytest.mark.django_db
def test_already_loaded_22_percent_leaves_the_old_record_alone() -> None:
    """Прежнюю запись могут держать строки документов — её не трогают."""
    _rate("VAT22", "22")
    old = _rate("VAT20", "20")

    migration.forward(apps, None)

    assert VatRate.objects.get(pk=old.pk).percent == Decimal("20.0000")


@pytest.mark.django_db
def test_rollback_restores_the_previous_rate() -> None:
    old = _rate("VAT20", "20")

    migration.forward(apps, None)
    migration.backward(apps, None)

    assert VatRate.objects.get(pk=old.pk).code == "VAT20"
