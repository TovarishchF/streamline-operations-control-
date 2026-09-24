"""Доступ к общим справочникам из `shared/reference/`.

Справочники общие с клиентом: выпадающий список на экране и проверка
на сервере обязаны опираться на один перечень, иначе форма предлагает
значение, которое сервер не принимает.
"""

from __future__ import annotations

import json
from functools import lru_cache

from django.conf import settings


@lru_cache(maxsize=1)
def country_codes() -> frozenset[str]:
    """Коды стран ISO 3166-1 alpha-2.

    Читается один раз: файл не меняется в течение работы процесса,
    а проверка кода происходит на каждой подаче формы.
    """
    path = settings.SHARED_DIR / "reference" / "countries.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return frozenset(str(code) for code in payload["codes"])
