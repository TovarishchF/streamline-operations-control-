"""Журнал действий — только добавление, запрет на уровне базы.

`BACKEND.md § 3.9` требует, чтобы изменение и удаление записи аудита были
невозможны не только в коде: код обходится сырым SQL, консолью Django
и любым другим клиентом базы.

Запрет сделан триггером, а не отзывом прав (ADR-033). Отзыв прав работает
только если приложение подключается учётной записью, не являющейся владельцем
таблицы: владельцу права не отзываются. Такая учётная запись заводится при
развёртывании, но в разработке и в испытаниях её нет, а критерий приёмки
требует, чтобы `UPDATE` падал на уровне базы в любом окружении. Триггер
выполняется независимо от того, кто подключился, и покрывает оба случая.
Разделение учётных записей при этом остаётся — как второй рубеж (`INFRA.md`).
"""

from __future__ import annotations

from django.db import migrations

FORWARD = """
CREATE OR REPLACE FUNCTION audit_entry_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Запись аудита неизменяема: операция % запрещена (BACKEND.md 3.9)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_no_update
    BEFORE UPDATE ON audit_auditentry
    FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();

CREATE TRIGGER audit_entry_no_delete
    BEFORE DELETE ON audit_auditentry
    FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();
"""

BACKWARD = """
DROP TRIGGER IF EXISTS audit_entry_no_update ON audit_auditentry;
DROP TRIGGER IF EXISTS audit_entry_no_delete ON audit_auditentry;
DROP FUNCTION IF EXISTS audit_entry_append_only();
"""


class Migration(migrations.Migration):
    dependencies = [("audit", "0001_initial")]

    operations = [migrations.RunSQL(sql=FORWARD, reverse_sql=BACKWARD)]
