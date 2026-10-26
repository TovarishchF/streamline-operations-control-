"""Признак записи генератора: `is_generated` вместо прежнего (шаг 1 из 2).

Новый столбец заводится рядом с прежним и заполняется из него. Прежний
удаляется следующей миграцией: переименование столбца с данными — две
миграции с переносом, а не одна (`CLAUDE.md § 3` п. 12).
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models

MODELS = ("registrationrequest",)

OLD = "is_demo"


def copy_forward(apps: Any, schema_editor: Any) -> None:
    for name in MODELS:
        apps.get_model("accounts", name).objects.filter(**{OLD: True}).update(is_generated=True)


def copy_backward(apps: Any, schema_editor: Any) -> None:
    for name in MODELS:
        apps.get_model("accounts", name).objects.filter(is_generated=True).update(**{OLD: True})


class Migration(migrations.Migration):
    dependencies = [("accounts", "0003_registrationrequest")]

    operations = [
        migrations.AddField(
            model_name="registrationrequest",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.RunPython(copy_forward, copy_backward),
    ]
