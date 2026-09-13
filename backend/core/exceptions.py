"""Доменные исключения.

Каждое несёт код из перечисления `ErrorCode` в `openapi.yaml` и отображается
в HTTP-код таблицей в `core.api.exceptions`, а не случайно (`BACKEND.md § 9`).
"""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Базовое доменное исключение."""

    code = "INTERNAL_ERROR"

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


class AuthenticationFailed(DomainError):
    """Неверные учётные данные либо неверный второй фактор `[ТЗ 4.3]`.

    Формулировка одна и та же для несуществующего пользователя и для
    неверного пароля: иначе форма входа превращается в справочник логинов.
    """

    code = "AUTHENTICATION_FAILED"


class AccountLocked(DomainError):
    """Учётная запись временно заблокирована после неудачных попыток `[ТЗ 4.3]`."""

    code = "ACCOUNT_LOCKED"


class TransitionNotAllowed(DomainError):
    """Переход автомата не существует из текущего состояния (`DOMAIN.md § 5`)."""

    code = "TRANSITION_NOT_ALLOWED"


class GuardNotSatisfied(DomainError):
    """Переход существует, но условия не выполнены.

    В `details.unmetConditions` перечисляется, чего именно не хватает, —
    интерфейс показывает этот список рядом с заблокированной кнопкой
    (`SPEC.md § 4.4`).
    """

    code = "GUARD_NOT_SATISFIED"


class ScheduleConflict(DomainError):
    """Конфликт расписания: пересечение, turnaround, неисправный борт, истёкший допуск."""

    code = "SCHEDULE_CONFLICT"


class ServiceCheckFailed(DomainError):
    """Не пройдены блокирующие проверки заказа услуги (`SPEC.md § 5.2`)."""

    code = "SERVICE_CHECK_FAILED"


class ContractExpired(DomainError):
    """У поставщика нет действующего контракта на дату оказания услуги."""

    code = "CONTRACT_EXPIRED"


class PriceNotFound(DomainError):
    """Нет действующей цены поставщика на дату оказания услуги."""

    code = "PRICE_NOT_FOUND"


class DocumentImmutable(DomainError):
    """Попытка изменить выставленный документ (`BACKEND.md § 3.4`)."""

    code = "DOCUMENT_IMMUTABLE"


class IdempotencyKeyRequired(DomainError):
    """Отсутствует обязательный заголовок `Idempotency-Key` (ADR-018)."""

    code = "IDEMPOTENCY_KEY_REQUIRED"


class IdempotencyKeyConflict(DomainError):
    """Тот же ключ использован для другого запроса."""

    code = "IDEMPOTENCY_KEY_CONFLICT"


class IntegrationUnavailable(DomainError):
    """Внешняя система недоступна.

    Система обязана деградировать предсказуемо: использовать последнее известное
    значение с отметкой давности, а не падать (`TASKS.md` M13).
    """

    code = "INTEGRATION_UNAVAILABLE"


class DemoOnlyOperation(DomainError):
    """Операция доступна только на демонстрационном стенде (ADR-014, ADR-008)."""

    code = "DEMO_ONLY_OPERATION"
