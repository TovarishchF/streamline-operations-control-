"""Признак записи генератора (шаг 2 из 2): прежний столбец удаляется.

Значения перенесены в `is_generated` предыдущей миграцией.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("counterparties", "0005_is_generated_add")]

    operations = [
        migrations.RemoveField(model_name="client", name=OLD),
        migrations.RemoveField(model_name="vendor", name=OLD),
        migrations.RemoveField(model_name="contact", name=OLD),
        migrations.RemoveField(model_name="vendorcertificate", name=OLD),
        migrations.RemoveField(model_name="vendorcontract", name=OLD),
        migrations.RemoveField(model_name="vendorservicemapping", name=OLD),
    ]
