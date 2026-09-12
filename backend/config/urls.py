"""Маршрутизация.

Базовый путь API — `/api/v1` (`SPEC.md § 10.2`). `/metrics` вынесен из
версионированного префикса: Prometheus скрейпит его отдельно и наружу он
не публикуется (G-46, `INFRA.md § 6`).
"""

from __future__ import annotations

from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularRedocView

from core.api.views import ClockView, HealthView

api_v1 = [
    path("health", HealthView.as_view(), name="health"),
    path("clock", ClockView.as_view(), name="clock"),
]

urlpatterns = [
    path("api/v1/", include((api_v1, "api"), namespace="v1")),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path(
        "api/docs/",
        SpectacularRedocView.as_view(url_name="schema"),
        name="redoc",
    ),
    path("", include("django_prometheus.urls")),
    path("django-admin/", admin.site.urls),
]

if settings.DEBUG:
    urlpatterns += [path("__debug__/", include([]))]
