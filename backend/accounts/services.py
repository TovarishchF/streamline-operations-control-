"""Вход, блокировка и второй фактор `[ТЗ 4.3]`.

`BACKEND.md § 6`. Вся логика входа здесь, вьюха её только вызывает
(`CLAUDE.md § 3` п. 10).

Вход двухшаговый. Первый шаг проверяет пароль и, если для роли включён
второй фактор, возвращает временный токен вместо пары токенов доступа.
Второй шаг обменивает временный токен и код на пару. Временный токен —
подписанное значение с коротким сроком, а не запись в базе: хранить
незавершённые попытки входа незачем.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, cast

import pyotp
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.db import transaction
from django.utils.translation import gettext as _
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import BackupCode, Role, TwoFactorDevice, User
from audit import services as audit
from audit.models import AuditEntityType, AuditSource
from core import clock
from core.exceptions import AccountLocked, AuthenticationFailed

# Срок жизни временного токена между шагами входа. Достаточно, чтобы взять
# телефон и прочитать код, и мало, чтобы токен где-то осел.
TWO_FACTOR_TOKEN_TTL = timedelta(minutes=5)
TWO_FACTOR_SALT = "soc.auth.two-factor"

BACKUP_CODE_COUNT = 10
BACKUP_CODE_BYTES = 5  # 10 символов в base32



@dataclass(frozen=True)
class TokenPair:
    access: str
    refresh: str
    expires_in: int


@dataclass(frozen=True)
class LoginResult:
    """Результат первого шага: либо токены, либо требование второго фактора."""

    two_factor_required: bool
    two_factor_token: str | None = None
    tokens: TokenPair | None = None


@dataclass(frozen=True)
class TwoFactorSetup:
    secret: str
    otpauth_url: str
    backup_codes: list[str]


def two_factor_required_for(role: str) -> bool:
    return role in set(settings.TWO_FACTOR_REQUIRED_ROLES)


def login(username: str, password: str) -> LoginResult:
    """Первый шаг входа.

    Сообщение об ошибке одинаково и для несуществующего пользователя, и для
    неверного пароля: иначе форма входа превращается в справочник логинов.
    """
    user = User.objects.filter(username=username).first()

    if user is not None and user.is_locked:
        raise AccountLocked(
            _("Учётная запись заблокирована до %(until)s UTC после неудачных попыток входа")
            % {"until": user.locked_until.strftime("%H:%M") if user.locked_until else ""}
        )

    if user is None or not user.is_active or not user.check_password(password):
        if user is not None:
            _register_failed_attempt(user)
        raise AuthenticationFailed(_("Неверный логин или пароль"))

    _reset_failed_attempts(user)

    if user.two_factor_enabled or two_factor_required_for(user.role):
        return LoginResult(
            two_factor_required=True,
            two_factor_token=signing.dumps({"user": user.pk}, salt=TWO_FACTOR_SALT),
        )

    _record_login(user, "logged_in")
    return LoginResult(two_factor_required=False, tokens=issue_tokens(user))


def verify_two_factor(two_factor_token: str, code: str) -> TokenPair:
    """Второй шаг: код из приложения-аутентификатора либо резервный код."""
    try:
        payload: dict[str, Any] = signing.loads(
            two_factor_token, salt=TWO_FACTOR_SALT, max_age=TWO_FACTOR_TOKEN_TTL
        )
    except signing.BadSignature as error:
        raise AuthenticationFailed(_("Срок подтверждения истёк, войдите заново")) from error

    user = User.objects.filter(pk=payload["user"], is_active=True).first()
    if user is None:
        raise AuthenticationFailed(_("Учётная запись недоступна"))
    if user.is_locked:
        raise AccountLocked(_("Учётная запись заблокирована после неудачных попыток входа"))

    if _check_totp(user, code):
        _reset_failed_attempts(user)
        _record_login(user, "logged_in")
        return issue_tokens(user)

    if _consume_backup_code(user, code):
        _reset_failed_attempts(user)
        _record_login(user, "logged_in_with_backup_code")
        return issue_tokens(user)

    _register_failed_attempt(user)
    raise AuthenticationFailed(_("Неверный код подтверждения"))


def issue_tokens(user: User) -> TokenPair:
    refresh = RefreshToken.for_user(user)
    lifetime = cast(timedelta, settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"])
    return TokenPair(
        access=str(refresh.access_token),
        refresh=str(refresh),
        expires_in=int(lifetime.total_seconds()),
    )


@transaction.atomic
def setup_two_factor(user: User) -> TwoFactorSetup:
    """Привязка приложения-аутентификатора и выдача резервных кодов.

    Повторный вызов заменяет и секрет, и коды: это же и способ отозвать
    доступ с потерянного телефона. Старые коды при этом перестают работать,
    поэтому операция пишется в аудит.
    """
    secret = pyotp.random_base32()
    TwoFactorDevice.objects.update_or_create(
        user=user, defaults={"secret": secret, "confirmed_at": None, "created_at": clock.now()}
    )

    user.backup_codes.all().delete()
    codes = [_generate_backup_code() for _ in range(BACKUP_CODE_COUNT)]
    BackupCode.objects.bulk_create(
        BackupCode(user=user, code_hash=make_password(code), created_at=clock.now())
        for code in codes
    )

    user.two_factor_enabled = True
    user.save(update_fields=["two_factor_enabled"])

    audit.record(
        entity_type=AuditEntityType.USER,
        entity_id=user.pk,
        action="two_factor_configured",
        actor=user,
        after={"two_factor_enabled": True, "backup_codes": BACKUP_CODE_COUNT},
    )

    issuer = "SOC"
    otpauth_url = pyotp.TOTP(secret).provisioning_uri(name=user.username, issuer_name=issuer)
    return TwoFactorSetup(secret=secret, otpauth_url=otpauth_url, backup_codes=codes)


def logout(refresh_token: str) -> None:
    """Помещает refresh-токен в чёрный список.

    Токен, который уже недействителен, — не ошибка: выход должен быть
    идемпотентным, иначе повторное нажатие кнопки покажет пользователю сбой.
    """
    try:
        # Заглушки типов объявляют аргументом уже разобранный токен,
        # но конструктор принимает и строку — так он и задуман.
        RefreshToken(refresh_token).blacklist()  # type: ignore[arg-type]
    except Exception:  # noqa: S110
        pass


# ─────────────────────────── внутреннее ───────────────────────────


def _check_totp(user: User, code: str) -> bool:
    device = TwoFactorDevice.objects.filter(user=user).first()
    if device is None:
        return False
    # valid_window=1 принимает соседний интервал: часы телефона и сервера
    # расходятся, и без этого допуска вход иногда не проходит.
    if not pyotp.TOTP(device.secret).verify(code, valid_window=1):
        return False
    if device.confirmed_at is None:
        device.confirmed_at = clock.now()
        device.save(update_fields=["confirmed_at"])
    return True


def _consume_backup_code(user: User, code: str) -> bool:
    """Резервный код срабатывает один раз.

    Отметка ставится под `select_for_update`: два одновременных входа с одним
    кодом иначе прошли бы оба.
    """
    normalized = code.strip().upper().replace("-", "")
    with transaction.atomic():
        unused = BackupCode.objects.select_for_update().filter(user=user, used_at__isnull=True)
        for backup in unused:
            if check_password(normalized, backup.code_hash):
                backup.used_at = clock.now()
                backup.save(update_fields=["used_at"])
                return True
    return False


def _generate_backup_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # без похожих символов
    return "".join(secrets.choice(alphabet) for _ in range(BACKUP_CODE_BYTES * 2))


def _register_failed_attempt(user: User) -> None:
    """Блокировка после превышения числа неудачных попыток, событие в аудит."""
    user.failed_login_attempts += 1
    fields = ["failed_login_attempts"]

    if user.failed_login_attempts >= settings.LOGIN_FAILURE_LIMIT:
        user.locked_until = clock.now() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
        user.failed_login_attempts = 0
        fields.append("locked_until")
        audit.record(
            entity_type=AuditEntityType.USER,
            entity_id=user.pk,
            action="account_locked",
            source=AuditSource.SYSTEM,
            after={"locked_until": user.locked_until.isoformat()},
            comment=_("Превышено число неудачных попыток входа"),
        )

    user.save(update_fields=fields)


def _reset_failed_attempts(user: User) -> None:
    if user.failed_login_attempts or user.locked_until:
        user.failed_login_attempts = 0
        user.locked_until = None
        user.save(update_fields=["failed_login_attempts", "locked_until"])


def _record_login(user: User, action: str) -> None:
    audit.record(
        entity_type=AuditEntityType.USER,
        entity_id=user.pk,
        action=action,
        actor=user,
        after={"role": Role(user.role).value},
    )
