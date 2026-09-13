"""Маршрутизация.

Базовый путь API — `/api/v1` (`SPEC.md § 10.2`). `/metrics` вынесен из
версионированного префикса: Prometheus скрейпит его отдельно и наружу он
не публикуется (G-46, `INFRA.md § 6`).

Набор маршрутов совпадает с `openapi.yaml` до пути и метода: лишний маршрут
валит проверку расхождения схемы, и это намеренно — контракт согласуется
с клиентами до кода (`CLAUDE.md § 3` п. 6).
"""

from __future__ import annotations

from django.conf import settings
from django.contrib import admin
from django.urls import URLPattern, URLResolver, include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularRedocView
from rest_framework.routers import DefaultRouter

from accounts.api.views import (
    LoginView,
    LogoutView,
    MeView,
    PasswordChangeView,
    RefreshView,
    TwoFactorSetupView,
    TwoFactorView,
    UserViewSet,
)
from audit.api.views import AuditViewSet
from catalog.api.views import (
    AircraftTypeViewSet,
    AirportViewSet,
    ServiceViewSet,
    VatRateViewSet,
)
from core.api.views import ClockView, HealthView
from fleet.api.views import AircraftViewSet

router = DefaultRouter(trailing_slash=False)
router.register("airports", AirportViewSet, basename="airport")
router.register("aircraft-types", AircraftTypeViewSet, basename="aircraft-type")
router.register("vat-rates", VatRateViewSet, basename="vat-rate")
router.register("catalog/services", ServiceViewSet, basename="service")
router.register("fleet", AircraftViewSet, basename="aircraft")
router.register("audit", AuditViewSet, basename="audit")
router.register("users", UserViewSet, basename="user")

auth_urls: list[URLPattern | URLResolver] = [
    path("login", LoginView.as_view(), name="login"),
    path("2fa", TwoFactorView.as_view(), name="two-factor"),
    path("2fa/setup", TwoFactorSetupView.as_view(), name="two-factor-setup"),
    path("refresh", RefreshView.as_view(), name="refresh"),
    path("logout", LogoutView.as_view(), name="logout"),
    path("me", MeView.as_view(), name="me"),
    path("password", PasswordChangeView.as_view(), name="password"),
]

api_v1: list[URLPattern | URLResolver] = [
    path("health", HealthView.as_view(), name="health"),
    path("clock", ClockView.as_view(), name="clock"),
    path("auth/", include(auth_urls)),
    *router.urls,
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
