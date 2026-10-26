"""Признак записи генератора (шаг 2 из 2): прежний столбец удаляется.

Значения перенесены в `is_generated` предыдущей миграцией.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("flights", "0003_is_generated_add")]

    operations = [
        migrations.RemoveField(model_name="flight", name=OLD),
        migrations.RemoveField(model_name="crewmember", name=OLD),
        migrations.RemoveField(model_name="flighttemplate", name=OLD),
        migrations.RemoveField(model_name="templateservice", name=OLD),
        migrations.RemoveField(model_name="flightrequest", name=OLD),
        migrations.RemoveField(model_name="slot", name=OLD),
    ]
