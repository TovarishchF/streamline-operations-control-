"""Эндпоинты справочников `[ТЗ 3.2.1]`.

Пути и форма ответа — по `openapi.yaml`: `/airports`, `/aircraft-types`,
`/vat-rates`, `/catalog/services`.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import Q, QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import filters, mixins, viewsets
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from accounts.permissions import Permission
from audit import services as audit
from audit.models import AuditEntityType
from catalog.api.serializers import (
    AircraftTypeSerializer,
    AirportSerializer,
    ServiceSerializer,
    VatRateSerializer,
)
from catalog.models import AircraftType, Airport, Service, VatRate
from core.api.idempotency import IdempotentCreateMixin
from core.api.viewsets import ReferenceViewSet, SocViewSetMixin


@extend_schema_view(list=extend_schema(summary="Справочник аэропортов", tags=["catalog"]))
class AirportViewSet(ReferenceViewSet):
    """`GET /api/v1/airports`.

    Читают все роли, у которых есть работа с рейсами или услугами: без
    аэропорта не прочитать ни расписание, ни заявку.
    """

    queryset = Airport.objects.all()
    serializer_class = AirportSerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.SCHEDULE_VIEW}
    filter_backends = (filters.OrderingFilter,)
    ordering_fields = ("icao", "iata", "country", "timezone", "name_ru", "name_en")
    ordering = ("icao",)

    def get_queryset(self) -> QuerySet[Airport]:
        queryset = super().get_queryset()
        search = self.request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                Q(icao__istartswith=search)
                | Q(iata__istartswith=search)
                | Q(name_ru__icontains=search)
                | Q(name_en__icontains=search)
                | Q(city_ru__icontains=search)
                | Q(city_en__icontains=search)
            )
        coordinated = self.request.query_params.get("isCoordinated")
        if coordinated in ("true", "false"):
            queryset = queryset.filter(is_coordinated=coordinated == "true")
        return queryset


@extend_schema_view(list=extend_schema(summary="Типы воздушных судов", tags=["catalog"]))
class AircraftTypeViewSet(ReferenceViewSet):
    """`GET /api/v1/aircraft-types`."""

    queryset = AircraftType.objects.all()
    serializer_class = AircraftTypeSerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.SCHEDULE_VIEW}
    filter_backends = (filters.OrderingFilter,)
    ordering_fields = ("icao_type", "category", "seats", "cruise_speed_kts")
    ordering = ("icao_type",)


@extend_schema_view(list=extend_schema(summary="Ставки НДС", tags=["catalog"]))
class VatRateViewSet(ReferenceViewSet):
    """`GET /api/v1/vat-rates`.

    Пагинации нет: ставок единицы, и контракт отдаёт их одним списком.
    """

    queryset = VatRate.objects.all()
    serializer_class = VatRateSerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.CATALOG_VIEW}
    pagination_class = None

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response({"data": self.get_serializer(self.get_queryset(), many=True).data})


@extend_schema_view(
    list=extend_schema(summary="Каталог услуг", tags=["catalog"]),
    create=extend_schema(summary="Добавить услугу", tags=["catalog"]),
    partial_update=extend_schema(summary="Изменить услугу", tags=["catalog"]),
)
class ServiceViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/catalog/services`.

    Удаления нет намеренно: услуга, по которой есть заявки, не может исчезнуть
    из истории. Вывод из обращения — снятие признака `is_active` (M5).
    """

    # Контракт объявляет только частичное изменение: PUT потребовал бы
    # присылать запись целиком, а маршрута под него в openapi.yaml нет.
    http_method_names = ["get", "post", "patch", "head", "options"]  # noqa: RUF012
    queryset = Service.objects.all()
    serializer_class = ServiceSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.CATALOG_VIEW,
        "create": Permission.CATALOG_EDIT,
        "update": Permission.CATALOG_EDIT,
        "partial_update": Permission.CATALOG_EDIT,
    }
    filter_backends = (filters.OrderingFilter,)
    ordering_fields = ("code", "category", "lead_time_h")
    ordering = ("category", "code")

    def get_queryset(self) -> QuerySet[Service]:
        queryset = super().get_queryset()
        category = self.request.query_params.get("category")
        if category:
            queryset = queryset.filter(category=category)
        return queryset

    def perform_create(self, serializer: BaseSerializer[Service]) -> None:
        service = serializer.save()
        audit.record(
            entity_type=AuditEntityType.SERVICE,
            entity_id=service.pk,
            action="created",
            actor=self.request.user,  # type: ignore[arg-type]
            after=audit.snapshot(service),
        )

    def perform_update(self, serializer: BaseSerializer[Service]) -> None:
        instance = serializer.instance
        assert isinstance(instance, Service)
        before = audit.snapshot(instance)
        service = serializer.save()
        audit.record(
            entity_type=AuditEntityType.SERVICE,
            entity_id=service.pk,
            action="updated",
            actor=self.request.user,  # type: ignore[arg-type]
            before=before,
            after=audit.snapshot(service),
        )
