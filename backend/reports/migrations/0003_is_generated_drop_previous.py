"""Признак записи генератора (шаг 2 из 2): прежний столбец удаляется.

Значения перенесены в `is_generated` предыдущей миграцией.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("reports", "0002_is_generated_add")]

    operations = [
        migrations.RemoveField(model_name="reportsubscription", name=OLD),
    ]
