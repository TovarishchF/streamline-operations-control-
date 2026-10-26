"""Боевые настройки.

Здесь же выполняется проверка безопасности при старте: обнаружение упрощённого
входа отказывает в запуске, а не пишет предупреждение (ADR-013).
"""

from __future__ import annotations

import sys

import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration

from .base import *
from .base import AUTHENTICATION_BACKENDS, SAMPLE_DATA, env

DEBUG = False
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")
SECRET_KEY = env("SECRET_KEY")

# ─────────────────────────── Безопасность ───────────────────────────
# INFRA.md § 6

SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31_536_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = env("SMTP_HOST", default="")
EMAIL_PORT = env.int("SMTP_PORT", default=587)
EMAIL_HOST_USER = env("SMTP_USER", default="")
EMAIL_HOST_PASSWORD = env("SMTP_PASSWORD", default="")
EMAIL_USE_TLS = True
DEFAULT_FROM_EMAIL = env("SMTP_FROM", default="")

if env("SENTRY_DSN", default=""):
    sentry_sdk.init(
        dsn=env("SENTRY_DSN"),
        integrations=[DjangoIntegration()],
        release=env("RELEASE_VERSION", default="unknown"),
        traces_sample_rate=0.1,
        send_default_pii=False,
    )


# ─────────────────────── Проверка настроек при старте ───────────────────────


def _fail(message: str) -> None:
    sys.stderr.write(f"ОТКАЗ ЗАПУСКА: {message}\n")
    raise SystemExit(1)


# ADR-013: упрощённый вход не должен существовать в боевой сборке.
_FORBIDDEN_BACKENDS = {"accounts.auth_backends.BypassLoginBackend"}
if _FORBIDDEN_BACKENDS & set(AUTHENTICATION_BACKENDS):
    _fail(
        "в AUTHENTICATION_BACKENDS обнаружен бэкенд обхода входа. "
        "Обход входа в боевом режиме недопустим (ADR-013)."
    )

if SECRET_KEY.startswith("insecure-"):
    _fail("SECRET_KEY не задан. Заполните переменную окружения из .env.")

# ADR-008: генератор данных в бою — не ошибка конфигурации, но факт,
# который должен быть виден в журнале при каждом запуске.
if SAMPLE_DATA:
    sys.stderr.write(
        "ВНИМАНИЕ: SAMPLE_DATA=true в боевой конфигурации. Администратору доступны "
        "генератор данных и управление модельным временем.\n"
    )
