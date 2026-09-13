"""Единство карты прав сервера и клиента `[ТЗ 4.3]` (`BACKEND.md § 6`).

Карта прав — один источник истины. Разойтись двум спискам легко: право
добавляют на сервере и забывают на клиенте, элемент интерфейса остаётся
скрытым, и никто этого не замечает, пока пользователь не пожалуется.
Обратный случай хуже: клиент показывает кнопку, которой сервер не даст
сработать.

Тест разбирает перечень прав в `web/src/shared/auth/permissions.ts` и
сверяет его с `accounts.permissions.Permission`. Это не подмена генерации,
а её дешёвая замена: генерировать TypeScript из Python ради одного списка
дороже, чем поймать расхождение проверкой.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from django.conf import settings

from accounts.permissions import Permission

WEB_PERMISSIONS = Path(settings.REPO_ROOT) / "web" / "src" / "shared" / "auth" / "permissions.ts"

# Перечень объявлен как `export const PERMISSIONS = [ … ] as const;`
PERMISSIONS_BLOCK = re.compile(r"export const PERMISSIONS = \[(.*?)\] as const;", re.DOTALL)


def _web_permissions() -> list[str]:
    source = WEB_PERMISSIONS.read_text(encoding="utf-8")
    block = PERMISSIONS_BLOCK.search(source)
    assert block is not None, "в permissions.ts не найден перечень PERMISSIONS"
    return re.findall(r"'([a-z][a-z_.]*)'", block.group(1))


@pytest.mark.skipif(not WEB_PERMISSIONS.exists(), reason="веб-клиент не в этой сборке")
class TestPermissionNamesMatch:
    def test_no_permission_exists_only_on_the_server(self) -> None:
        extra = sorted(set(Permission.values) - set(_web_permissions()))
        assert extra == [], (
            f"права есть на сервере, но не объявлены в веб-клиенте: {extra}. "
            f"Элемент интерфейса для них останется скрытым навсегда"
        )

    def test_no_permission_exists_only_in_the_client(self) -> None:
        extra = sorted(set(_web_permissions()) - set(Permission.values))
        assert extra == [], (
            f"права объявлены в веб-клиенте, но сервер их не знает: {extra}. "
            f"Клиент покажет кнопку, а сервер ответит 403"
        )

    def test_client_list_has_no_duplicates(self) -> None:
        names = _web_permissions()
        assert len(names) == len(set(names))
