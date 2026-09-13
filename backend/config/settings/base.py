"""Общие настройки SOC.

Разделение base/dev/prod/test — по `BACKEND.md § 2`. Отдельного «демо-кода»
не существует: демонстрационный стенд отличается только переменными окружения
(`INFRA.md § 2`, ADR-008).
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent
REPO_ROOT = BASE_DIR.parent
# Каталог, общий с клиентами: автоматы состояний и справочники (CLAUDE.md § 6).
# В контейнере смонтирован в /shared, при локальном запуске — рядом с backend/.
SHARED_DIR = REPO_ROOT / "shared"

env = environ.Env()
env_file = REPO_ROOT / ".env"
if env_file.exists():
    environ.Env.read_env(str(env_file))

SECRET_KEY: str = env("SECRET_KEY", default="insecure-dev-key-replace-in-prod")
DEBUG: bool = env.bool("DEBUG", default=False)
ALLOWED_HOSTS: list[str] = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

# ─────────────────────────── Режим демонстрации ───────────────────────────
# ADR-008: признак демонстрационных ДАННЫХ. Режимы внешних подключений
# на маркировку документов не влияют — они видны на /admin/integrations.
DEMO_DATA: bool = env.bool("DEMO_DATA", default=False)

# ─────────────────────────── Приложения ───────────────────────────

DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "rest_framework_simplejwt",
    "django_filters",
    "drf_spectacular",
    "django_celery_beat",
    "django_prometheus",
]

LOCAL_APPS = [
    "core",
    "accounts",
    "catalog",
    "counterparties",
    "fleet",
    "flights",
    "orders",
    "billing",
    "comms",
    "reports",
    "integrations",
    "audit",
    "demo",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

MIDDLEWARE = [
    "django_prometheus.middleware.PrometheusBeforeMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.locale.LocaleMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_prometheus.middleware.PrometheusAfterMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES: list[dict[str, Any]] = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ─────────────────────────── База данных ───────────────────────────
# ADR-001: PostgreSQL — единственная СУБД.

DATABASES = {
    "default": env.db_url(
        "DATABASE_URL",
        default="postgres://soc:soc@localhost:5432/soc",
    ),
}

# Реплика только для чтения: отчёты и BI (ADR-005). Появляется на M9/M13.
if env("REPLICA_DATABASE_URL", default=""):
    DATABASES["replica"] = env.db_url("REPLICA_DATABASE_URL")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "accounts.User"

# ─────────────────────────── Кэш и очередь ───────────────────────────

REDIS_URL: str = env("REDIS_URL", default="redis://localhost:6379/0")

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    },
}

CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_TASK_ALWAYS_EAGER = False
CELERY_TIMEZONE = "UTC"
CELERY_ENABLE_UTC = True
CELERY_TASK_ACKS_LATE = True
# Поведение по умолчанию в Celery 6: повторять подключение к брокеру при старте.
# Задаётся явно, иначе воркер пишет предупреждение при каждом запуске.
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"

# ─────────────────────────── Локализация и время ───────────────────────────
# CLAUDE.md § 3 п. 2: хранение в UTC, локальное время только на отображении.

LANGUAGE_CODE = "ru"
LANGUAGES = [("ru", "Русский"), ("en", "English")]
LOCALE_PATHS = [BASE_DIR / "locale"]
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# ─────────────────────────── Файлы ───────────────────────────

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# ADR-007: вложения только в S3-совместимом хранилище, никакого IndexedDB.
STORAGES = {
    "default": {
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": env("S3_BUCKET", default="soc"),
            "endpoint_url": env("S3_ENDPOINT", default="http://localhost:9000"),
            "access_key": env("S3_ACCESS_KEY", default=""),
            "secret_key": env("S3_SECRET_KEY", default=""),
            "querystring_auth": True,
            "querystring_expire": 900,
            "file_overwrite": False,
        },
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}

FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024
ALLOWED_ATTACHMENT_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
]

# ─────────────────────────── REST API ───────────────────────────

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_FILTER_BACKENDS": ("django_filters.rest_framework.DjangoFilterBackend",),
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "core.api.pagination.SocPagination",
    "PAGE_SIZE": 50,
    "EXCEPTION_HANDLER": "core.api.exceptions.soc_exception_handler",
    "COERCE_DECIMAL_TO_STRING": True,  # CLAUDE.md § 3 п. 1: деньги в JSON — строкой
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "ALGORITHM": "HS256",
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# G-52: drf-spectacular по умолчанию отдаёт 3.0.3, контракт требует 3.1.
SPECTACULAR_SETTINGS = {
    "TITLE": "SOC — Streamline Operations Control API",
    "VERSION": "1.0.0-draft",
    "OAS_VERSION": "3.1.0",
    "SCHEMA_PATH_PREFIX": "/api/v1",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SORT_OPERATIONS": False,
}

# ─────────────────────────── Аутентификация ───────────────────────────
# ADR-013: обхода аутентификации в боевом режиме не существует.

AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGIN_FAILURE_LIMIT = 5
LOGIN_LOCKOUT_MINUTES = 15
TWO_FACTOR_REQUIRED_ROLES = ["admin", "finance"]

# ─────────────────────────── Внешние подключения ───────────────────────────
# INTEGRATIONS.md § 1: режим на каждое подключение, по умолчанию stub.
# Доменный код режима не видит — только фабрику адаптера.

INTEGRATION_MODES: dict[str, str] = {
    code: env(f"INTEGRATION_{code}_MODE", default="stub")
    for code in [
        "FX", "WX", "TRACK", "APT", "SMTP", "MSGR",
        "MAILBOT", "LDAP", "ONEC", "EDO", "BI", "SLOT", "VENDOR_API", "IATA",
    ]
}

INTEGRATION_STUB_LATENCY_MS = (80, 400)
INTEGRATION_STUB_ERROR_RATE = 0.02  # INTEGRATIONS § 1 п. 3
INTEGRATION_LOG_BODY_RETENTION_DAYS = 30

# ─────────────────────────── Деньги ───────────────────────────
# ADR-002. Единственное место, где заданы эти константы.

MONEY_DECIMAL_PLACES = 4
MONEY_DISPLAY_PLACES = 2
MONEY_MAX_DIGITS = 18
SUPPORTED_CURRENCIES = ["RUB", "USD", "EUR"]
FX_BASE_CURRENCY = "RUB"

# ─────────────────────────── Логирование ───────────────────────────

LOGGING: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.json.JsonFormatter",
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "json"},
    },
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", default="INFO")},
    "loggers": {
        "django.db.backends": {"level": "WARNING"},
        "soc.integrations": {"level": "INFO"},
        "soc.audit": {"level": "INFO"},
    },
}
