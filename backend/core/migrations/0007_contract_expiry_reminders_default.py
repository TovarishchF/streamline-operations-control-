"""Пороги напоминаний об истечении договоров (`SPEC.md § 6.3`).

До этой миграции значение по умолчанию было пустым списком, и напоминания
не формировались бы вовсе. Заполняются только пустые: заданное
администратором не трогается.
"""

from __future__ import annotations

from django.db import migrations


def fill(apps, schema_editor):  # type: ignore[no-untyped-def]
    Settings = apps.get_model("core", "Settings")
    Settings.objects.filter(contract_expiry_reminders=[]).update(
        contract_expiry_reminders=[30, 15, 7]
    )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0006_rating_and_suggest_weights"),
    ]

    operations = [
        migrations.RunPython(fill, migrations.RunPython.noop),
    ]
