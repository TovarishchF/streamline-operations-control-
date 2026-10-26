"""Правила SLA по умолчанию (G-39).

Сроков подтверждения от заказчика нет: значения заданы нами до ответа
и редактируются на `/admin/sla`. Штрафы по умолчанию отключены, срок
исполнения не задан — его нет ни в ТЗ, ни в ответах заказчика, и
придумывать его значило бы считать нарушения, которых никто не обещал.
"""

from __future__ import annotations

from django.db import migrations
from ulid import ULID

# (категория, срок подтверждения в минутах). Пустая категория —
# правило по умолчанию для всего, что не покрыто остальными.
DEFAULTS = (
    ("", 240),
    ("fuel", 120),
    ("handling", 240),
    ("catering", 240),
    ("transport", 240),
    ("permits", 1440),
    ("deicing", 60),
)


def create_defaults(apps, schema_editor):  # type: ignore[no-untyped-def]
    from django.utils import timezone

    SlaRule = apps.get_model("orders", "SlaRule")
    now = timezone.now()
    for category, minutes in DEFAULTS:
        if SlaRule.objects.filter(
            category=category, vendor__isnull=True, superseded_at__isnull=True
        ).exists():
            continue
        SlaRule.objects.create(
            id=f"sla_{ULID()}",
            created_at=now,
            updated_at=now,
            category=category,
            vendor=None,
            confirm_minutes=minutes,
            completion_minutes=None,
            penalty_kind="none",
            penalty_value=None,
        )


def remove_defaults(apps, schema_editor):  # type: ignore[no-untyped-def]
    SlaRule = apps.get_model("orders", "SlaRule")
    SlaRule.objects.filter(vendor__isnull=True, superseded_at__isnull=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("orders", "0005_sla_rules"),
    ]

    operations = [
        migrations.RunPython(create_defaults, remove_defaults),
    ]
