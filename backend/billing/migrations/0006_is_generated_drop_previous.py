"""Признак записи генератора (шаг 2 из 2): прежний столбец удаляется.

Значения перенесены в `is_generated` предыдущей миграцией.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("billing", "0005_is_generated_add")]

    operations = [
        migrations.RemoveField(model_name="fxrate", name=OLD),
        migrations.RemoveField(model_name="tariffrule", name=OLD),
        migrations.RemoveField(model_name="quote", name=OLD),
        migrations.RemoveField(model_name="invoice", name=OLD),
        migrations.RemoveField(model_name="documentline", name=OLD),
        migrations.RemoveField(model_name="payable", name=OLD),
        migrations.RemoveField(model_name="vendorinvoice", name=OLD),
        migrations.RemoveField(model_name="vendorinvoiceline", name=OLD),
    ]
