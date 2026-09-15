"""Фильтры печатной формы отчёта.

Строка отчёта — словарь, а колонки известны только во время выполнения:
шаблон обращается к значению по ключу колонки. В языке шаблонов Django
такого обращения нет — `{{ row.key }}` ищет поле с именем «key», а не
значение переменной.
"""

from __future__ import annotations

from typing import Any

from django import template

register = template.Library()


@register.filter
def get(source: Any, key: str) -> Any:
    """Значение по ключу. Отсутствующий ключ даёт `None`, а не ошибку.

    Тип источника — `Any`, а не словарь: в шаблон значение приходит без
    проверки типов, и падение печатной формы из-за неожиданного значения
    хуже пустой ячейки.
    """
    if not isinstance(source, dict):
        return None
    value: Any = source.get(key)
    return value
