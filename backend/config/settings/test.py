"""Настройки тестов.

Внешние подключения всегда в stub: сеть в тестах не используется
(`TESTING.md § 4`). Режим live проверяется против записанных ответов.
"""

from __future__ import annotations

from .base import *
from .base import INTEGRATION_MODES

DEBUG = False
DEMO_DATA = False

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
