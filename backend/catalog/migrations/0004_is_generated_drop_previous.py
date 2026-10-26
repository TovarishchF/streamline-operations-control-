"""Признак записи генератора (шаг 2 из 2): прежний столбец удаляется.

Значения перенесены в `is_generated` предыдущей миграцией.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("catalog", "0003_is_generated_add")]

    operations = [
        migrations.RemoveField(model_name="airport", name=OLD),
        migrations.RemoveField(model_name="aircrafttype", name=OLD),
        migrations.RemoveField(model_name="service", name=OLD),
        migrations.RemoveField(model_name="vatrate", name=OLD),
        migrations.RemoveField(model_name="vendorprice", name=OLD),
    ]
