"""Настройки разработки."""

from __future__ import annotations

from .base import *
from .base import INSTALLED_APPS, env

DEBUG = True
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [*INSTALLED_APPS, "django_extensions"] if env.bool(
    "USE_DJANGO_EXTENSIONS", default=False
) else INSTALLED_APPS

# Почта в dev перехватывается Mailpit: письма реально уходят, но наружу не выходят
# (INTEGRATIONS § 3.1). Наружу — только при INTEGRATION_SMTP_MODE=live.
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = env("SMTP_HOST", default="localhost")
EMAIL_PORT = env.int("SMTP_PORT", default=1025)

# Настроек CORS здесь нет намеренно. Веб-клиент и API живут на одном
# происхождении: в разработке запросы на /api/ проксирует Vite, в бою —
# nginx (INFRA.md § 1). Межсайтовых запросов к API не возникает, а разрешать
# их «на всякий случай» значит открывать API любому стороннему сайту.
