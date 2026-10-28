"""Что очистка набора генератора оставляет на месте `[ТЗ этап 2]` (ADR-016, ADR-041).

Очистка удаляет записи с `is_generated` и не трогает введённое людьми. Запись
человека может ссылаться на запись набора: цена, которую человек добавил
поставщику из набора, пользователь портала, заведённый на клиента из набора.
Удалить такую запись набора нельзя, не задев запись человека: связь `CASCADE`
унесла бы её молча, связь `PROTECT` оборвала бы всю очистку.

Поэтому такие записи набора остаются вместе со всем, на что они сами
ссылаются, а очистка сообщает, что оставлено и почему. Признак `is_generated`
у них сохраняется: когда ссылка человека уйдёт, следующая очистка их удалит.

Пользователи генератора остаются вне этого правила: их пароль напечатан
в инструкции, и в системе после очистки их быть не должно. Ссылки на них из
записей людей (кто согласовал, кто загрузил) обнуляются связью `SET_NULL`,
а кто что сделал, по-прежнему видно в журнале действий.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from django.db import models

from accounts.models import User

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

GENERATED_EMAIL_DOMAIN = "soc.local"


@dataclass(frozen=True)
class KeptRecord:
    """Запись набора, оставленная очисткой, и причина."""

    entity: str
    id: str
    title: str
    reason: str


@dataclass(frozen=True)
class Outcome:
    """Итог очистки или пересоздания: числа по видам записей и оставленное."""

    counts: dict[str, int]
    kept: list[KeptRecord]


Kept = dict[type[models.Model], dict[str, str]]


def find_kept(targets: Sequence[type[models.Model]]) -> Kept:
    """Записи набора среди `targets`, которые очистка удалить не может.

    Сначала — записи набора, на которые прямо ссылаются записи людей, затем
    всё, на что ссылаются уже оставленные записи набора: удалить предка,
    не задев оставленного потомка, нельзя. Возвращает `{модель: {pk: причина}}`.
    """
    target_set = set(targets)
    kept: Kept = {}
    frontier: list[tuple[type[models.Model], str]] = []

    for model in _referrers(target_set):
        for field in _links(model, target_set):
            rows = _human_rows(model).filter(**{f"{field.name}__is_generated": True})
            for referrer in rows.select_related(field.name):
                target = getattr(referrer, field.name)
                if _keep(kept, type(target), str(target.pk), _describe(referrer)):
                    frontier.append((type(target), str(target.pk)))

    # Предки оставленных записей набора остаются вместе с ними.
    while frontier:
        model, pk = frontier.pop()
        record = model._default_manager.get(pk=pk)
        for field in _links(model, target_set):
            target = getattr(record, field.name)
            if target is None or not target.is_generated:
                continue
            if _keep(kept, type(target), str(target.pk), _describe(record)):
                frontier.append((type(target), str(target.pk)))
    return kept


def describe_kept(kept: Kept) -> list[KeptRecord]:
    """Список для отчёта: что оставлено и какая запись это держит."""
    result: list[KeptRecord] = []
    for model, reasons in kept.items():
        for record in model._default_manager.filter(pk__in=reasons):
            result.append(
                KeptRecord(
                    entity=str(model._meta.verbose_name),
                    id=str(record.pk),
                    title=str(record),
                    reason=reasons[str(record.pk)],
                )
            )
    return sorted(result, key=lambda item: (item.entity, item.title))


def _keep(kept: Kept, model: type[models.Model], pk: str, reason: str) -> bool:
    """Отмечает запись оставленной; `True`, если отмечена впервые."""
    reasons = kept.setdefault(model, {})
    if pk in reasons:
        return False
    reasons[pk] = reason
    return True


def _referrers(targets: set[type[models.Model]]) -> Iterable[type[models.Model]]:
    """Модели, у которых есть связь на удаляемые модели."""
    from django.apps import apps

    return [model for model in apps.get_models() if _links(model, targets)]


def _links(
    model: type[models.Model], targets: set[type[models.Model]]
) -> list[models.ForeignKey[models.Model, models.Model]]:
    """Связи модели на удаляемые модели набора (`ForeignKey` и `OneToOneField`)."""
    return [
        field
        for field in model._meta.get_fields()
        if isinstance(field, models.ForeignKey) and field.related_model in targets
    ]


def _human_rows(model: type[models.Model]) -> models.QuerySet[models.Model]:
    """Записи людей в модели.

    Пользователь признака не несёт — генератора выдаёт адрес в зоне
    `soc.local` (ADR-038 п. 5). Модель без признака и не пользователь
    целиком считается введённой людьми: так безопаснее, чем наоборот.
    """
    queryset = model._default_manager.all()
    if model is User:
        return queryset.exclude(email__endswith=f"@{GENERATED_EMAIL_DOMAIN}")
    if any(field.name == "is_generated" for field in model._meta.get_fields()):
        return queryset.filter(is_generated=False)
    return queryset


def _describe(record: models.Model) -> str:
    return f"{record._meta.verbose_name} «{record}»"
