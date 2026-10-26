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
    AccountListView,
    LoginView,
    LogoutView,
    MeView,
    PasswordChangeView,
    RefreshView,
    RegistrationConfirmView,
    RegistrationRequestViewSet,
    RegistrationView,
    TwoFactorSetupView,
    TwoFactorView,
    UserViewSet,
)
from audit.api.views import AuditViewSet
from billing.api.documents import InvoiceViewSet, QuoteViewSet
from billing.api.payables import (
    PayableViewSet,
    ReconciliationDetailView,
    ReconciliationImportView,
    ReconciliationListView,
    ReconciliationResolveView,
    ReconciliationTemplateView,
)
from billing.api.payments import PaymentViewSet
from billing.api.views import FlightMarginView, FxRatesView
from catalog.api.views import (
    AircraftTypeViewSet,
    AirportViewSet,
    ServiceViewSet,
    VatRateViewSet,
    VendorPriceViewSet,
)
from comms.api.views import (
    InboxViewSet,
    MessageTemplateViewSet,
    NotificationViewSet,
    OutboxViewSet,
)
from core.api.attachments import AttachmentConfirmView, AttachmentCreateView
from core.api.views import ClockView, HealthView
from counterparties.api.views import (
    ClientViewSet,
    VendorContractViewSet,
    VendorServiceMappingViewSet,
    VendorViewSet,
)
from fleet.api.views import AircraftViewSet
from flights.api.views import (
    FlightRequestViewSet,
    FlightTemplateViewSet,
    FlightViewSet,
    ScheduleConflictsView,
    ScheduleExportView,
    SlotViewSet,
)
from integrations.api.views import (
    IntegrationCheckView,
    IntegrationListView,
    IntegrationLogListView,
)
from orders.api.sla import SlaRuleListView
from orders.api.views import ServiceOrderViewSet
from reports.api.views import (
    ReportBuildView,
    ReportCatalogView,
    ReportExportView,
    ReportSubscriptionViewSet,
)
from sampledata.api.views import SampleDataGenerateView, SampleDataPurgeView, SampleDataResetView

router = DefaultRouter(trailing_slash=False)
# Конфликты объявлены до вьюсета рейсов: иначе «conflicts» разберётся
# как идентификатор рейса и вернёт 404.
router.register("flights", FlightViewSet, basename="flight")
router.register("flight-templates", FlightTemplateViewSet, basename="flight-template")
router.register("flight-requests", FlightRequestViewSet, basename="flight-request")
router.register("slots", SlotViewSet, basename="slot")
router.register("service-orders", ServiceOrderViewSet, basename="service-order")
router.register("clients", ClientViewSet, basename="client")
router.register("vendors", VendorViewSet, basename="vendor")
router.register("airports", AirportViewSet, basename="airport")
router.register("aircraft-types", AircraftTypeViewSet, basename="aircraft-type")
router.register("vat-rates", VatRateViewSet, basename="vat-rate")
router.register("catalog/services", ServiceViewSet, basename="service")
router.register("catalog/prices", VendorPriceViewSet, basename="vendor-price")
router.register("contracts", VendorContractViewSet, basename="contract")
router.register("fleet", AircraftViewSet, basename="aircraft")
router.register("quotes", QuoteViewSet, basename="quote")
router.register("invoices", InvoiceViewSet, basename="invoice")
router.register("payables", PayableViewSet, basename="payable")
router.register("payments", PaymentViewSet, basename="payment")
router.register(
    "vendor-service-mappings",
    VendorServiceMappingViewSet,
    basename="vendor-service-mapping",
)
router.register("audit", AuditViewSet, basename="audit")
router.register("notifications", NotificationViewSet, basename="notification")
router.register("outbox", OutboxViewSet, basename="outbox")
router.register("inbox", InboxViewSet, basename="inbox")
router.register("message-templates", MessageTemplateViewSet, basename="message-template")
router.register(
    "report-subscriptions", ReportSubscriptionViewSet, basename="report-subscription"
)
router.register("users", UserViewSet, basename="user")
router.register(
    "registration-requests", RegistrationRequestViewSet, basename="registration-request"
)

auth_urls: list[URLPattern | URLResolver] = [
    path("login", LoginView.as_view(), name="login"),
    path("2fa", TwoFactorView.as_view(), name="two-factor"),
    path("2fa/setup", TwoFactorSetupView.as_view(), name="two-factor-setup"),
    path("refresh", RefreshView.as_view(), name="refresh"),
    path("logout", LogoutView.as_view(), name="logout"),
    path("me", MeView.as_view(), name="me"),
    path("accounts", AccountListView.as_view(), name="auth-accounts"),
    path("register", RegistrationView.as_view(), name="auth-register"),
    path(
        "register/confirm",
        RegistrationConfirmView.as_view(),
        name="auth-register-confirm",
    ),
    path("password", PasswordChangeView.as_view(), name="password"),
]

api_v1: list[URLPattern | URLResolver] = [
    path("health", HealthView.as_view(), name="health"),
    path("clock", ClockView.as_view(), name="clock"),
    path("auth/", include(auth_urls)),
    path("fx-rates", FxRatesView.as_view(), name="fx-rates"),
    path("reconciliation", ReconciliationListView.as_view(), name="reconciliation-list"),
    path(
        "reconciliation/import",
        ReconciliationImportView.as_view(),
        name="reconciliation-import",
    ),
    # До `reconciliation/<pk>`: иначе «template» разберётся как идентификатор.
    path(
        "reconciliation/template",
        ReconciliationTemplateView.as_view(),
        name="reconciliation-template",
    ),
    path(
        "reconciliation/<str:pk>",
        ReconciliationDetailView.as_view(),
        name="reconciliation-detail",
    ),
    path(
        "reconciliation/<str:pk>/resolve",
        ReconciliationResolveView.as_view(),
        name="reconciliation-resolve",
    ),
    path("attachments", AttachmentCreateView.as_view(), name="attachment-create"),
    path(
        "attachments/<str:attachment_id>/confirm",
        AttachmentConfirmView.as_view(),
        name="attachment-confirm",
    ),
    path("flights/conflicts", ScheduleConflictsView.as_view(), name="flight-conflicts"),
    path("flights/export", ScheduleExportView.as_view(), name="flight-export"),
    path("flights/<str:pk>/margin", FlightMarginView.as_view(), name="flight-margin"),
    path("sample-data/generate", SampleDataGenerateView.as_view(), name="sample-data-generate"),
    path("sample-data/reset", SampleDataResetView.as_view(), name="sample-data-reset"),
    path("sample-data/purge", SampleDataPurgeView.as_view(), name="sample-data-purge"),
    path("integrations", IntegrationListView.as_view(), name="integration-list"),
    path("integrations/logs", IntegrationLogListView.as_view(), name="integration-logs"),
    path(
        "integrations/<str:code>/test",
        IntegrationCheckView.as_view(),
        name="integration-check",
    ),
    path("sla-rules", SlaRuleListView.as_view(), name="sla-rules"),
    path("reports", ReportCatalogView.as_view(), name="report-catalog"),
    path("reports/<str:code>", ReportBuildView.as_view(), name="report-build"),
    path("reports/<str:code>/export", ReportExportView.as_view(), name="report-export"),
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
