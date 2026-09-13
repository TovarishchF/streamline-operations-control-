"""Единый обработчик ошибок.

`BACKEND.md § 9`: формат `{ error: { code, message, details? } }`, доменные
исключения отображаются в HTTP-коды таблицей, а не случайно.

Правило формулировки сообщения: пользователь должен понять, что делать.
Не «ошибка валидации», а «у поставщика X истёк контракт 12.03.2026, выберите
другого или продлите договор».
"""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import status
from rest_framework.exceptions import APIException, NotAuthenticated, PermissionDenied
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from core.exceptions import (
    AccountLocked,
    AuthenticationFailed,
    ContractExpired,
    DemoOnlyOperation,
    DomainError,
    GuardNotSatisfied,
    IdempotencyKeyRequired,
    IntegrationUnavailable,
    PriceNotFound,
    ScheduleConflict,
    ServiceCheckFailed,
    TransitionNotAllowed,
)
from core.money import CurrencyMismatch

# Таблица соответствия доменных исключений кодам ответа.
# Ни одно доменное исключение не должно превращаться в 500.
_DOMAIN_STATUS: dict[type[Exception], int] = {
    AuthenticationFailed: status.HTTP_401_UNAUTHORIZED,
    AccountLocked: status.HTTP_423_LOCKED,
    TransitionNotAllowed: status.HTTP_409_CONFLICT,
    GuardNotSatisfied: status.HTTP_409_CONFLICT,
    ScheduleConflict: status.HTTP_409_CONFLICT,
    ServiceCheckFailed: status.HTTP_422_UNPROCESSABLE_ENTITY,
    ContractExpired: status.HTTP_422_UNPROCESSABLE_ENTITY,
    PriceNotFound: status.HTTP_422_UNPROCESSABLE_ENTITY,
    CurrencyMismatch: status.HTTP_400_BAD_REQUEST,
    IdempotencyKeyRequired: status.HTTP_400_BAD_REQUEST,
    DemoOnlyOperation: status.HTTP_403_FORBIDDEN,
    IntegrationUnavailable: status.HTTP_503_SERVICE_UNAVAILABLE,
}


def _build(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"error": error}


# Стандартные исключения DRF и Django с заранее заданной формулировкой.
# Http404 возвращается и при обращении к чужой записи в порталах: факт её
# существования не раскрывается (ADR-003).
_SIMPLE_EXCEPTIONS: list[tuple[type[Exception], str, str, int]] = [
    (Http404, "NOT_FOUND", "Запись не найдена.", status.HTTP_404_NOT_FOUND),
    (
        NotAuthenticated,
        "AUTHENTICATION_FAILED",
        "Требуется вход в систему.",
        status.HTTP_401_UNAUTHORIZED,
    ),
    (
        PermissionDenied,
        "PERMISSION_DENIED",
        "Недостаточно прав для этого действия.",
        status.HTTP_403_FORBIDDEN,
    ),
]


def soc_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    """Обработчик исключений DRF."""

    if isinstance(exc, DomainError):
        http_status = _DOMAIN_STATUS.get(type(exc), status.HTTP_400_BAD_REQUEST)
        return Response(_build(exc.code, str(exc), exc.details), status=http_status)

    if isinstance(exc, CurrencyMismatch):
        return Response(
            _build("CURRENCY_MISMATCH", str(exc)),
            status=status.HTTP_400_BAD_REQUEST,
        )

    for exc_type, code, message, http_status in _SIMPLE_EXCEPTIONS:
        if isinstance(exc, exc_type):
            return Response(_build(code, message), status=http_status)

    if isinstance(exc, DjangoValidationError):
        return Response(
            _build("VALIDATION_ERROR", "; ".join(exc.messages)),
            status=status.HTTP_400_BAD_REQUEST,
        )

    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    if isinstance(exc, APIException):
        details = response.data if isinstance(response.data, dict) else {"detail": response.data}
        is_client_error = response.status_code == status.HTTP_400_BAD_REQUEST
        response.data = _build(
            "VALIDATION_ERROR" if is_client_error else "INTERNAL_ERROR",
            str(exc.detail) if not isinstance(exc.detail, dict | list) else "Ошибка запроса.",
            details,
        )
    return response
