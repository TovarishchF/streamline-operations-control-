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
from billing.api.views import FxRatesView
from catalog.api.views import (
    AircraftTypeViewSet,
    AirportViewSet,
    ServiceViewSet,
    VatRateViewSet,
    VendorPriceViewSet,
)
from core.api.attachments import AttachmentConfirmView, AttachmentCreateView
from core.api.views import ClockView, HealthView
from counterparties.api.views import ClientViewSet, VendorContractViewSet, VendorViewSet
from fleet.api.views import AircraftViewSet
from flights.api.views import (
    FlightRequestViewSet,
    FlightTemplateViewSet,
    FlightViewSet,
    ScheduleConflictsView,
    SlotViewSet,
)

router = DefaultRouter(trailing_slash=False)
# Конфликты объявлены до вьюсета рейсов: иначе «conflicts» разберётся
# как идентификатор рейса и вернёт 404.
router.register("flights", FlightViewSet, basename="flight")
router.register("flight-templates", FlightTemplateViewSet, basename="flight-template")
router.register("flight-requests", FlightRequestViewSet, basename="flight-request")
router.register("slots", SlotViewSet, basename="slot")
router.register("clients", ClientViewSet, basename="client")
router.register("vendors", VendorViewSet, basename="vendor")
router.register("airports", AirportViewSet, basename="airport")
router.register("aircraft-types", AircraftTypeViewSet, basename="aircraft-type")
router.register("vat-rates", VatRateViewSet, basename="vat-rate")
router.register("catalog/services", ServiceViewSet, basename="service")
router.register("catalog/prices", VendorPriceViewSet, basename="vendor-price")
router.register("contracts", VendorContractViewSet, basename="contract")
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
    path("fx-rates", FxRatesView.as_view(), name="fx-rates"),
    path("attachments", AttachmentCreateView.as_view(), name="attachment-create"),
    path(
        "attachments/<str:attachment_id>/confirm",
        AttachmentConfirmView.as_view(),
        name="attachment-confirm",
    ),
    path("flights/conflicts", ScheduleConflictsView.as_view(), name="flight-conflicts"),
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
