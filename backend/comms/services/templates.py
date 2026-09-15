"""Шаблоны исходящих сообщений `[ТЗ 3.5.2]` (`SPEC.md § 8.2`).

Подстановка вида `{{flight.number}}`. Намеренно не движок шаблонов Django:
шаблон редактирует пользователь через интерфейс, а язык шаблонов Django —
это исполняемый код с тегами, фильтрами и доступом к методам объектов.
Текст, который вводит человек в форму, исполнять нельзя.

Здесь работает только одно правило: `{{путь.через.точку}}` заменяется на
значение из словаря данных. Ни условий, ни циклов, ни вызовов.

Неизвестная переменная **не** заменяется на пустую строку: письмо
с провалом посреди фразы уходит поставщику и выглядит как сбой системы.
Вместо этого имя остаётся видимым, а список пропусков возвращается —
предпросмотр показывает его человеку до отправки.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from core.exceptions import DomainError

PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")


class TemplateNotFound(DomainError):
    code = "NOT_FOUND"


class RenderResult:
    """Результат сборки: текст и перечень непокрытых переменных."""

    __slots__ = ("body", "missing", "subject")

    def __init__(self, subject: str, body: str, missing: list[str]) -> None:
        self.subject = subject
        self.body = body
        self.missing = missing


def resolve(path: str, data: dict[str, Any]) -> Any:
    """Значение по пути через точку. `None`, если пути нет."""
    current: Any = data
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
        if current is None:
            return None
    return current


def _format(value: Any) -> str:
    """Значение в текст письма.

    `Decimal` печатается как есть, без приведения к float: сумма в письме
    поставщику — та же сумма, что в документе (`CLAUDE.md § 3` п. 1).
    """
    if isinstance(value, Decimal):
        return f"{value:f}"
    return str(value)


def render(text: str, data: dict[str, Any]) -> tuple[str, list[str]]:
    """Подставляет значения. Возвращает текст и список пропущенных имён."""
    missing: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        path = match.group(1)
        value = resolve(path, data)
        if value is None:
            missing.append(path)
            # Имя остаётся видимым: пропуск должен бросаться в глаза
            # в предпросмотре, а не растворяться в тексте.
            return match.group(0)
        return _format(value)

    return PLACEHOLDER.sub(substitute, text), missing


def render_template(template: Any, *, locale: str, data: dict[str, Any]) -> RenderResult:
    """Собирает тему и тело шаблона на выбранном языке."""
    subject, missing_subject = render(template.subject_for(locale), data)
    body, missing_body = render(template.body_for(locale), data)
    return RenderResult(
        subject=subject,
        body=body,
        missing=sorted(set(missing_subject) | set(missing_body)),
    )


def variables_in(template: Any) -> list[str]:
    """Переменные, встречающиеся в тексте шаблона на обоих языках."""
    found: set[str] = set()
    for text in (
        template.subject_ru,
        template.subject_en,
        template.body_ru,
        template.body_en,
    ):
        found.update(match.group(1) for match in PLACEHOLDER.finditer(text))
    return sorted(found)
