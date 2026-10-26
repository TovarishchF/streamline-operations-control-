"""Признак записи генератора: `is_generated` вместо прежнего (шаг 1 из 2).

Новый столбец заводится рядом с прежним и заполняется из него. Прежний
удаляется следующей миграцией: переименование столбца с данными — две
миграции с переносом, а не одна (`CLAUDE.md § 3` п. 12).
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models

MODELS = ("fxrate", "tariffrule", "quote", "invoice", "documentline", "payable", "vendorinvoice", "vendorinvoiceline")

OLD = "is_demo"


def copy_forward(apps: Any, schema_editor: Any) -> None:
    for name in MODELS:
        apps.get_model("billing", name).objects.filter(**{OLD: True}).update(is_generated=True)


def copy_backward(apps: Any, schema_editor: Any) -> None:
    for name in MODELS:
        apps.get_model("billing", name).objects.filter(is_generated=True).update(**{OLD: True})


class Migration(migrations.Migration):
    dependencies = [("billing", "0004_remove_payable_payable_approved_has_date_and_more")]

    operations = [
        migrations.AddField(
            model_name="fxrate",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="tariffrule",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="quote",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="invoice",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="documentline",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="payable",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="vendorinvoice",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.AddField(
            model_name="vendorinvoiceline",
            name="is_generated",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text="Запись генератора данных, удаляется командой seed_sample --purge",
            ),
        ),
        migrations.RunPython(copy_forward, copy_backward),
    ]
