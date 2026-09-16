"""Управление демонстрационным набором `[ТЗ этап 2]` (ADR-008, ADR-016).

`/demo/seed`, `/demo/reset`, `/demo/purge` — пути и формы по `openapi.yaml`.

Действие выполняется синхронно. Генерация набора занимает секунды,
а очередь задач здесь только добавила бы вопрос «а она вообще началась?»
там, где ответ нужен сразу. Если набор вырастет настолько, что ожидание
станет заметным, это повод завести задачу, а не повод заводить её сейчас.
"""

from __future__ import annotations

from typing import Any, ClassVar

from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import Permission
from core.api.idempotency import IdempotencyMixin
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from demo import services as demo


class DemoSeedRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`DemoSeedRequest` из контракта."""

    seed = serializers.IntegerField(required=False, default=demo.DEFAULT_SEED)


class DemoResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`DemoResult` из контракта."""

    action = serializers.ChoiceField(choices=[demo.SEED, demo.RESET, demo.PURGE])
    counts = serializers.DictField(child=serializers.IntegerField())
    message = serializers.CharField(allow_blank=True)


class DemoActionView(IdempotencyMixin, APIView):
    """Общее для трёх действий: права, идемпотентность, форма ответа."""

    idempotency: ClassVar[str] = "required"
    permission_classes: Any = (HasRolePermission,)
    # Управление набором — право администратора: кнопка «Очистить» убирает
    # со стенда всё, что показывают заказчику.
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.ADMIN}

    action_name: ClassVar[str] = ""

    def _seed(self, request: Request) -> int:
        payload = DemoSeedRequestSerializer(data=request.data or {})
        payload.is_valid(raise_exception=True)
        return int(payload.validated_data["seed"])

    def _result(self, counts: dict[str, int], message: str = "") -> Response:
        return Response(
            {"action": self.action_name, "counts": counts, "message": message},
            status=status.HTTP_200_OK,
        )


class DemoSeedView(DemoActionView):
    """`POST /api/v1/demo/seed`."""

    action_name = demo.SEED

    @extend_schema(
        summary="Генерация демонстрационного набора",
        request=DemoSeedRequestSerializer,
        responses={200: DemoResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        seed = self._seed(request)
        return self.idempotent(request, lambda: self._result(demo.generate(seed)))


class DemoResetView(DemoActionView):
    """`POST /api/v1/demo/reset`."""

    action_name = demo.RESET

    @extend_schema(
        summary="Пересоздание демонстрационного набора",
        request=DemoSeedRequestSerializer,
        responses={200: DemoResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        seed = self._seed(request)
        return self.idempotent(request, lambda: self._result(demo.reset(seed)))


class DemoPurgeView(DemoActionView):
    """`POST /api/v1/demo/purge`."""

    action_name = demo.PURGE

    @extend_schema(
        summary="Очистка демонстрационных данных",
        request=None,
        responses={200: DemoResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        def produce() -> Response:
            return self._result(
                demo.purge(),
                # Про журнал сказано в ответе, а не только в документации:
                # администратор нажимает «Очистить» и вправе знать, что
                # именно не удалилось (`BACKEND.md § 3.9`).
                "Записи журнала действий не удаляются: таблица аудита "
                "только пополняется.",
            )

        return self.idempotent(request, produce)
