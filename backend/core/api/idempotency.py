"""Идемпотентность операций записи (ADR-018, `BACKEND.md § 3.8`).

Заголовок `Idempotency-Key` на POST. Ключ и ответ кладутся в Redis на сутки:
повтор с тем же ключом возвращает первый результат, а не создаёт второй рейс.
Диспетчер нажимает кнопку дважды регулярно — на плохой связи это норма.

Политика объявлена в контракте (`x-idempotency`) и проверяется контрактным
тестом. `required` — без ключа запрос отклоняется; `optional` — ключ
соблюдается, если прислан.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any, ClassVar

from django.core.cache import cache
from rest_framework import status
from rest_framework.response import Response

from core.exceptions import IdempotencyKeyConflict, IdempotencyKeyRequired

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.request import Request

HEADER = "Idempotency-Key"
TTL_SECONDS = 24 * 60 * 60
MIN_KEY_LENGTH = 8


class IdempotentCreateMixin:
    """Проверка ключа идемпотентности для операций создания.

    `idempotency = "required" | "optional"` — так же, как в контракте.

    Вьюха вызывает `idempotent()` явно, а не полагается на подмену `create`
    через `super()`: порядок наследования тогда становится значимым,
    и собственный `create` во вьюсете молча отключает всю проверку.
    """

    idempotency: ClassVar[str] = "optional"

    def idempotent(self, request: Request, produce: Callable[[], Response]) -> Response:
        """Выполняет операцию один раз на ключ.

        Повтор с тем же ключом возвращает первый ответ. Повтор с тем же
        ключом, но другим телом — ошибка клиента, а не повтор: вернуть
        первый ответ значило бы тихо потерять вторую операцию.
        """
        key = request.headers.get(HEADER, "").strip()

        if not key:
            if self.idempotency == "required":
                raise IdempotencyKeyRequired(
                    f"Операция требует заголовок {HEADER}: он защищает от повторного "
                    f"создания записи при повторе запроса"
                )
            return produce()

        if len(key) < MIN_KEY_LENGTH:
            raise IdempotencyKeyRequired(
                f"Значение {HEADER} короче {MIN_KEY_LENGTH} символов: такой ключ "
                f"не различает операции"
            )

        cache_key = _cache_key(request, key)
        stored = cache.get(cache_key)
        if stored is not None:
            if stored["fingerprint"] != _fingerprint(request):
                raise IdempotencyKeyConflict(
                    f"Ключ {key} уже использован с другим содержимым запроса. "
                    f"Для новой операции нужен новый ключ"
                )
            return Response(stored["body"], status=stored["status"])

        response = produce()
        if status.is_success(response.status_code):
            cache.set(
                cache_key,
                {
                    "fingerprint": _fingerprint(request),
                    "status": response.status_code,
                    "body": response.data,
                },
                TTL_SECONDS,
            )
        return response

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Стандартное создание DRF, обёрнутое проверкой ключа."""

        def produce() -> Response:
            result: Response = super(IdempotentCreateMixin, self).create(  # type: ignore[misc]
                request, *args, **kwargs
            )
            return result

        return self.idempotent(request, produce)


def _cache_key(request: Request, key: str) -> str:
    """Ключ живёт в пределах пользователя и пути.

    Один и тот же ключ у разных пользователей — разные операции, и ответ
    одного не должен доставаться другому.
    """
    user_id = getattr(request.user, "pk", "anonymous")
    return f"soc:idempotency:{user_id}:{request.path}:{key}"


def _fingerprint(request: Request) -> str:
    """Отпечаток тела запроса.

    Повтор с тем же ключом, но другим телом — это ошибка клиента, а не
    повтор. Вернуть первый ответ в такой ситуации значит тихо потерять
    вторую операцию.
    """
    payload = json.dumps(request.data, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
