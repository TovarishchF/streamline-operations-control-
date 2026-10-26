"""Типы сущностей журнала совпадают с контрактом `[ТЗ 3.6.3]`.

Клиент проверяет ответ по `openapi.yaml`, и запись с типом, которого
контракт не знает, роняет весь экран журнала. Проверка схемы этого
не ловит: поле отдаётся строкой, а не перечислением.
"""

from __future__ import annotations

import yaml
from django.conf import settings

from audit.models import AuditEntityType


def test_contract_lists_every_entity_type_the_server_writes() -> None:
    contract = yaml.safe_load((settings.REPO_ROOT / "openapi.yaml").read_text(encoding="utf-8"))
    declared = contract["components"]["schemas"]["AuditEntityType"]["enum"]

    assert sorted(declared) == sorted(AuditEntityType.values)
