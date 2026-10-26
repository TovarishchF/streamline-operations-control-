"""Признак записи генератора в журнале: столбец переименовывается.

Исключение из правила «две миграции с переносом» (`CLAUDE.md § 3` п. 12):
журнал неизменяем на уровне базы (0002_append_only), и перенос значений
в новый столбец — это `UPDATE` каждой строки, который триггер отклоняет.
Отключать триггер ради миграции значило бы на время сделать журнал
изменяемым. `ALTER TABLE … RENAME COLUMN` не трогает строки: значения
остаются на месте, триггер не срабатывает, данные не теряются.
"""

from __future__ import annotations

from django.db import migrations

OLD = "is_demo"


class Migration(migrations.Migration):
    dependencies = [("audit", "0002_append_only")]

    operations = [
        migrations.RenameField(model_name="auditentry", old_name=OLD, new_name="is_generated"),
    ]
