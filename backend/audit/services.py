"""Запись в журнал действий.

Единственный способ добавить запись аудита. Вьюхи и сервисы вызывают
`record()`, а не создают `AuditEntry` напрямую: здесь считается diff,
подставляется реальное время и проставляется происхождение.

`BACKEND.md § 3.9`: diff считается сервисом и хранится как JSONB. Готовый
текст «было → стало» не хранится — он собирается на отображении
(`DOMAIN.md § 8`), иначе журнал нельзя перевести на второй язык.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import models

from accounts.models import Role, User
from audit.models import AuditEntityType, AuditEntry, AuditSource
from core import clock

if TYPE_CHECKING:
    from collections.abc import Iterable

# Поля, которые меняются при каждом сохранении и в журнале только шумят.
NOISE_FIELDS = frozenset({"updated_at", "version"})

SYSTEM_ACTOR_ID = "sys_system"
SEED_ACTOR_NAME = "System (демо-генератор)"


def snapshot(instance: models.Model, fields: Iterable[str] | None = None) -> dict[str, Any]:
    """Снимок полей записи в виде, пригодном для JSONB.

    Берутся только собственные поля модели: связанные объекты разворачиваются
    в идентификатор, иначе один снимок потянет за собой половину базы.
    """
    # _meta.fields — собственные поля модели без обратных связей: снимок
    # не должен тянуть за собой связанные наборы.
    names = list(fields) if fields is not None else [f.attname for f in instance._meta.fields]
    result: dict[str, Any] = {}
    for name in names:
        if name in NOISE_FIELDS:
            continue
        result[name] = _to_json(getattr(instance, name, None))
    return result


def _to_json(value: Any) -> Any:
    """Приведение к типам, которые переживут сериализацию в JSONB.

    `Decimal` — строкой: деньги и проценты через число с плавающей точкой
    не проходят ни на одном уровне, включая JSON (`CLAUDE.md § 3` п. 1).
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, models.Model):
        return value.pk
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, str | int | float | bool | None | list | dict):
        return value
    return str(value)


def diff(
    before: dict[str, Any] | None, after: dict[str, Any] | None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Оставляет только изменившиеся поля.

    Хранить снимок целиком дорого и нечитаемо: в журнале нужно видеть, что
    именно поменялось. При создании `before` пуст, при удалении пуст `after` —
    в этих случаях снимок сохраняется целиком.
    """
    if before is None or after is None:
        return before, after
    changed = [key for key in set(before) | set(after) if before.get(key) != after.get(key)]
    if not changed:
        return None, None
    return (
        {key: before.get(key) for key in sorted(changed)},
        {key: after.get(key) for key in sorted(changed)},
    )


def record(
    *,
    entity_type: AuditEntityType | str,
    entity_id: str,
    action: str,
    actor: User | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    comment: str = "",
    source: AuditSource = AuditSource.USER,
    is_demo: bool = False,
) -> AuditEntry | None:
    """Добавляет запись в журнал. Возвращает `None`, если менять было нечего.

    Действие без автора — это `system` или `seed`: пользователь подставляется
    условный, но происхождение записи видно и подменой человека не выглядит.
    """
    before_changed, after_changed = diff(before, after)
    if before_changed is None and after_changed is None and before is not None:
        return None

    if actor is not None:
        actor_id = actor.pk
        actor_name = str(actor.get_full_name() or actor.username)
        actor_role = actor.role
    elif source == AuditSource.SEED:
        actor_id, actor_name, actor_role = SYSTEM_ACTOR_ID, SEED_ACTOR_NAME, Role.ADMIN
    else:
        actor_id, actor_name, actor_role = SYSTEM_ACTOR_ID, "System", Role.ADMIN

    return AuditEntry.objects.create(
        # Реальное время: модельное время стенда не искажает журнал (ADR-014),
        # но факт сдвига в записи виден.
        ts=clock.real_now(),
        clock_shifted=clock.is_shifted(),
        actor_id=actor_id,
        actor_name=actor_name,
        actor_role=actor_role,
        source=source,
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        before=before_changed,
        after=after_changed,
        comment=comment,
        is_demo=is_demo,
    )
