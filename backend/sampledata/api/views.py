"""Управление набором данных генератора `[ТЗ этап 2]` (ADR-008, ADR-016).

`/sample-data/generate`, `/sample-data/reset`, `/sample-data/purge` — пути
и формы по `openapi.yaml`.

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
from sampledata import services as sample


class SampleDataRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`SampleDataRequest` из контракта."""

    seed = serializers.IntegerField(required=False, default=sample.DEFAULT_SEED)


class SampleDataResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`SampleDataResult` из контракта."""

    action = serializers.ChoiceField(choices=[sample.GENERATE, sample.RESET, sample.PURGE])
    counts = serializers.DictField(child=serializers.IntegerField())
    message = serializers.CharField(allow_blank=True)


class SampleDataActionView(IdempotencyMixin, APIView):
    """Общее для трёх действий: права, идемпотентность, форма ответа."""

    idempotency: ClassVar[str] = "required"
    permission_classes: Any = (HasRolePermission,)
    # Управление набором — право администратора: кнопка «Очистить» убирает
    # из системы всё, что генератор в неё положил.
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.ADMIN}

    action_name: ClassVar[str] = ""

    def _seed(self, request: Request) -> int:
        payload = SampleDataRequestSerializer(data=request.data or {})
        payload.is_valid(raise_exception=True)
        return int(payload.validated_data["seed"])

    def _result(self, counts: dict[str, int], message: str = "") -> Response:
        return Response(
            {"action": self.action_name, "counts": counts, "message": message},
            status=status.HTTP_200_OK,
        )


class SampleDataGenerateView(SampleDataActionView):
    """`POST /api/v1/sample-data/generate`."""

    action_name = sample.GENERATE

    @extend_schema(
        summary="Генерация набора данных",
        request=SampleDataRequestSerializer,
        responses={200: SampleDataResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        seed = self._seed(request)
        return self.idempotent(request, lambda: self._result(sample.generate(seed)))


class SampleDataResetView(SampleDataActionView):
    """`POST /api/v1/sample-data/reset`."""

    action_name = sample.RESET

    @extend_schema(
        summary="Пересоздание набора данных",
        request=SampleDataRequestSerializer,
        responses={200: SampleDataResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        seed = self._seed(request)
        return self.idempotent(request, lambda: self._result(sample.reset(seed)))


class SampleDataPurgeView(SampleDataActionView):
    """`POST /api/v1/sample-data/purge`."""

    action_name = sample.PURGE

    @extend_schema(
        summary="Очистка данных генератора",
        request=None,
        responses={200: SampleDataResultSerializer, 403: ErrorResponseSerializer},
        tags=["admin"],
    )
    def post(self, request: Request) -> Response:
        def produce() -> Response:
            return self._result(
                sample.purge(),
                # Про журнал сказано в ответе, а не только в документации:
                # администратор нажимает «Очистить» и вправе знать, что
                # именно не удалилось (`BACKEND.md § 3.9`).
                "Записи журнала действий не удаляются: таблица аудита "
                "только пополняется.",
            )

        return self.idempotent(request, produce)
