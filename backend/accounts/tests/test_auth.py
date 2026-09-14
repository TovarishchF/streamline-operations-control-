"""Вход, блокировка и второй фактор `[ТЗ 4.3]`.

Критерии приёмки M3: «2FA работает с обычным приложением-аутентификатором,
резервные коды одноразовые». Приложение-аутентификатор здесь заменяется
той же библиотекой TOTP, которой пользуется и оно, — по секрету из
`otpauth://`-ссылки. Это и есть проверка совместимости: код, посчитанный
снаружи по опубликованному секрету, должен подойти.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import pyotp
import pytest
from django.conf import settings
from django.core import signing
from django.urls import reverse

from accounts import services
from accounts.models import BackupCode, Role, User
from audit.models import AuditEntry
from core import clock
from tests.factories import PASSWORD

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient


@pytest.mark.django_db
class TestLogin:
    def test_successful_login_returns_tokens(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        make_user(Role.DISPATCHER)

        response = api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": PASSWORD},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["twoFactorRequired"] is False
        assert response.data["tokens"]["access"]
        assert response.data["tokens"]["expiresIn"] == 900

    def test_wrong_password_is_refused(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        make_user(Role.DISPATCHER)

        response = api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": "не тот пароль"},
            format="json",
        )

        assert response.status_code == 401
        assert response.data["error"]["code"] == "AUTHENTICATION_FAILED"

    def test_unknown_user_is_indistinguishable_from_wrong_password(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        """Иначе форма входа превращается в справочник логинов."""
        make_user(Role.DISPATCHER)

        unknown = api.post(
            reverse("v1:login"), {"username": "нет-такого", "password": PASSWORD}, format="json"
        )
        wrong = api.post(
            reverse("v1:login"), {"username": "dispatcher-1", "password": "мимо"}, format="json"
        )

        assert unknown.status_code == wrong.status_code == 401
        assert unknown.data["error"] == wrong.data["error"]

    def test_login_is_recorded_in_audit(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.DISPATCHER)

        api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": PASSWORD},
            format="json",
        )

        entry = AuditEntry.objects.get(action="logged_in")
        assert entry.actor_id == user.pk
        assert entry.actor_role == Role.DISPATCHER


@pytest.mark.django_db
class TestLockout:
    def test_account_locks_after_five_failures(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        make_user(Role.DISPATCHER)

        for _ in range(settings.LOGIN_FAILURE_LIMIT):
            api.post(
                reverse("v1:login"),
                {"username": "dispatcher-1", "password": "мимо"},
                format="json",
            )

        response = api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": PASSWORD},
            format="json",
        )

        assert response.status_code == 423
        assert response.data["error"]["code"] == "ACCOUNT_LOCKED"

    def test_lock_is_recorded_in_audit_as_a_system_event(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        make_user(Role.DISPATCHER)

        for _ in range(settings.LOGIN_FAILURE_LIMIT):
            api.post(
                reverse("v1:login"),
                {"username": "dispatcher-1", "password": "мимо"},
                format="json",
            )

        entry = AuditEntry.objects.get(action="account_locked")
        assert entry.source == "system"

    def test_lock_expires(self, api: APIClient, make_user: Callable[..., User]) -> None:
        user = make_user(Role.DISPATCHER)
        user.locked_until = clock.now() - timedelta(seconds=1)
        user.save(update_fields=["locked_until"])

        response = api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": PASSWORD},
            format="json",
        )

        assert response.status_code == 200

    def test_successful_login_clears_the_counter(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.DISPATCHER)

        for _ in range(settings.LOGIN_FAILURE_LIMIT - 1):
            api.post(
                reverse("v1:login"),
                {"username": "dispatcher-1", "password": "мимо"},
                format="json",
            )
        api.post(
            reverse("v1:login"),
            {"username": "dispatcher-1", "password": PASSWORD},
            format="json",
        )

        user.refresh_from_db()
        assert user.failed_login_attempts == 0


@pytest.mark.django_db
class TestTwoFactor:
    def test_second_step_appears_once_the_application_is_bound(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.FINANCE)
        services.setup_two_factor(user)

        response = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["twoFactorRequired"] is True
        assert response.data["tokens"] is None
        assert response.data["twoFactorToken"]

    def test_first_login_without_a_bound_application_is_allowed(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        """Иначе финансист не войдёт никогда: привязать приложение можно
        только изнутри системы. Требование политики превращается
        в обязанность привязать его сразу после входа."""
        make_user(Role.FINANCE)

        response = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["twoFactorRequired"] is False
        assert response.data["tokens"]["access"]

    def test_profile_reports_that_binding_is_required(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        api = as_role(Role.FINANCE)

        response = api.get(reverse("v1:me"))

        assert response.data["twoFactorSetupRequired"] is True

    def test_binding_removes_the_requirement(
        self, as_role: Callable[..., APIClient], make_user: Callable[..., User]
    ) -> None:
        api = as_role(Role.FINANCE)

        api.post(reverse("v1:two-factor-setup"))

        assert api.get(reverse("v1:me")).data["twoFactorSetupRequired"] is False

    def test_dispatcher_is_not_forced_to_bind(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        """Политика перечисляет роли явно: диспетчеру привязка не навязывается."""
        api = as_role(Role.DISPATCHER)

        assert api.get(reverse("v1:me")).data["twoFactorSetupRequired"] is False

    def test_code_from_an_authenticator_application_works(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        """Секрет отдаётся ссылкой otpauth://, код считается по ней снаружи."""
        user = make_user(Role.FINANCE)
        setup = services.setup_two_factor(user)

        assert setup.otpauth_url.startswith("otpauth://totp/")
        assert f"secret={setup.secret}" in setup.otpauth_url

        login = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )
        code = pyotp.TOTP(setup.secret).now()

        response = api.post(
            reverse("v1:two-factor"),
            {"twoFactorToken": login.data["twoFactorToken"], "code": code},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["access"]

    def test_wrong_code_is_refused(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.FINANCE)
        services.setup_two_factor(user)

        login = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )

        response = api.post(
            reverse("v1:two-factor"),
            {"twoFactorToken": login.data["twoFactorToken"], "code": "000000"},
            format="json",
        )

        assert response.status_code == 401

    def test_backup_code_works_once(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        """Критерий приёмки: резервные коды одноразовые."""
        user = make_user(Role.FINANCE)
        setup = services.setup_two_factor(user)
        code = setup.backup_codes[0]

        first_login = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )
        first = api.post(
            reverse("v1:two-factor"),
            {"twoFactorToken": first_login.data["twoFactorToken"], "code": code},
            format="json",
        )
        assert first.status_code == 200

        second_login = api.post(
            reverse("v1:login"),
            {"username": "finance-1", "password": PASSWORD},
            format="json",
        )
        second = api.post(
            reverse("v1:two-factor"),
            {"twoFactorToken": second_login.data["twoFactorToken"], "code": code},
            format="json",
        )

        assert second.status_code == 401
        assert BackupCode.objects.filter(user=user, used_at__isnull=False).count() == 1

    def test_ten_backup_codes_are_issued_and_stored_hashed(
        self, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.ADMIN)

        setup = services.setup_two_factor(user)

        assert len(setup.backup_codes) == services.BACKUP_CODE_COUNT
        assert len(set(setup.backup_codes)) == services.BACKUP_CODE_COUNT
        stored = BackupCode.objects.filter(user=user).values_list("code_hash", flat=True)
        assert all(code not in stored for code in setup.backup_codes)

    def test_expired_two_factor_token_is_refused(
        self, api: APIClient, make_user: Callable[..., User]
    ) -> None:
        user = make_user(Role.FINANCE)
        setup = services.setup_two_factor(user)
        stale = signing.dumps({"user": user.pk}, salt=services.TWO_FACTOR_SALT)

        # Подпись верна, но срок истёк: проверяем именно срок.
        original_ttl = services.TWO_FACTOR_TOKEN_TTL
        services.TWO_FACTOR_TOKEN_TTL = timedelta(seconds=-1)
        try:
            response = api.post(
                reverse("v1:two-factor"),
                {"twoFactorToken": stale, "code": pyotp.TOTP(setup.secret).now()},
                format="json",
            )
        finally:
            services.TWO_FACTOR_TOKEN_TTL = original_ttl

        assert response.status_code == 401


@pytest.mark.django_db
class TestMe:
    def test_profile_carries_the_permission_map(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.get(reverse("v1:me"))

        assert response.status_code == 200
        assert response.data["user"]["role"] == Role.DISPATCHER
        assert response.data["permissions"]["flight.create"] is True
        assert response.data["permissions"]["catalog.edit"] is False

    def test_demo_marker_reflects_the_setting(
        self, as_role: Callable[..., APIClient], settings: object
    ) -> None:
        """ADR-008: маркировка стенда зависит только от `DEMO_DATA`."""
        api = as_role(Role.DISPATCHER)

        assert api.get(reverse("v1:me")).data["demoMode"] is False


@pytest.mark.django_db
class TestPasswordPolicy:
    def test_short_password_is_refused(self, as_role: Callable[..., APIClient]) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:password"),
            {"currentPassword": PASSWORD, "newPassword": "korotkiy1"},
            format="json",
        )

        assert response.status_code == 400

    def test_password_changes_and_is_recorded(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:password"),
            {"currentPassword": PASSWORD, "newPassword": "novyy-dlinnyy-parol-2026"},
            format="json",
        )

        assert response.status_code == 204
        user = User.objects.get(role=Role.DISPATCHER)
        assert user.check_password("novyy-dlinnyy-parol-2026")
        assert AuditEntry.objects.filter(action="password_changed").exists()

    def test_wrong_current_password_is_refused(
        self, as_role: Callable[..., APIClient]
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:password"),
            {"currentPassword": "мимо", "newPassword": "novyy-dlinnyy-parol-2026"},
            format="json",
        )

        assert response.status_code == 401
