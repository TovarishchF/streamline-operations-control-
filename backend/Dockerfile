FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# WeasyPrint требует системных библиотек для печатных форм (BACKEND.md § 8),
# python-ldap собирается из исходников и требует заголовков OpenLDAP и SASL
# (django-auth-ldap, INTEGRATIONS.md § 4.1).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev libpango-1.0-0 libpangoft2-1.0-0 \
        libcairo2 libgdk-pixbuf-2.0-0 libffi-dev shared-mime-info curl \
        libldap2-dev libsasl2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install -e ".[dev,ldap]"

COPY . .

# Приложение работает не от root (INFRA.md § 6)
RUN useradd --create-home --uid 1000 soc && chown -R soc:soc /app
USER soc

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/v1/health || exit 1

CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
