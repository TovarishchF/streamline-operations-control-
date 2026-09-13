"""Настройки тестов.

Внешние подключения всегда в stub: сеть в тестах не используется
(`TESTING.md § 4`). Режим live проверяется против записанных ответов.
"""

from __future__ import annotations

from .base import *
from .base import DATABASES, INTEGRATION_MODES, env

DEBUG = False
DEMO_DATA = False

# Тесты работают с настоящей PostgreSQL: часть проверок — про поведение самой
# базы (неизменяемость журнала, JSONB, ограничения). Подменять её на SQLite
# значит не проверять как раз то, ради чего тест написан.
#
# Адрес отличается от рабочего: из контейнера база видна как db:5432, а
# с машины разработчика — на localhost и на порту из DB_HOST_PORT, потому что
# 5432 на Windows попадает в зарезервированный Hyper-V диапазон. В CI переменная
# не задана, и берётся DATABASE_URL окружения.
_test_database_url = env.str("TEST_DATABASE_URL", default="")
if _test_database_url:
    DATABASES = {**DATABASES, "default": env.db_url_config(_test_database_url)}

INTEGRATION_MODES = dict.fromkeys(INTEGRATION_MODES, "stub")
INTEGRATION_STUB_LATENCY_MS = (0, 0)
INTEGRATION_STUB_ERROR_RATE = 0.0

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
