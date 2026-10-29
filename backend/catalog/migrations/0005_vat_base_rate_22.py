"""Базовая ставка НДС 22 % с 01.01.2026 (Федеральный закон от 28.11.2025 № 425-ФЗ).

Справочник `shared/reference/vat-rates.json` вместо `VAT20` несёт `VAT22`.
Ставка 20 % перестала действовать до начала работы системы, документов по ней
в системе быть не может, поэтому запись справочника меняется на месте:
строки документов ссылаются на неё же и после изменения. Документы набора
генератора, построенные по прежней ставке, пересчитываются пересозданием
набора (`seed_sample --purge`, затем `seed_sample`).

Если `VAT22` уже загружена `seed_reference`, прежняя запись не трогается:
на неё могут ссылаться строки документов.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db import migrations

OLD = {
    "code": "VAT20",
    "name_ru": "НДС 20 %",
    "name_en": "VAT 20%",
    "percent": Decimal("20.0000"),
    "legal_basis": "НК РФ ст. 164 п. 3",
}
NEW = {
    "code": "VAT22",
    "name_ru": "НДС 22 %",
    "name_en": "VAT 22%",
    "percent": Decimal("22.0000"),
    "legal_basis": "НК РФ ст. 164 п. 3 в ред. Федерального закона от 28.11.2025 № 425-ФЗ",
}


def _replace(apps: Any, before: dict[str, Any], after: dict[str, Any]) -> None:
    rate = apps.get_model("catalog", "VatRate")
    if rate.objects.filter(code=after["code"]).exists():
        return
    rate.objects.filter(code=before["code"]).update(**after)


def forward(apps: Any, schema_editor: Any) -> None:
    _replace(apps, OLD, NEW)


def backward(apps: Any, schema_editor: Any) -> None:
    _replace(apps, NEW, OLD)


class Migration(migrations.Migration):
    dependencies = [("catalog", "0004_is_generated_drop_previous")]

    operations = [migrations.RunPython(forward, backward)]
