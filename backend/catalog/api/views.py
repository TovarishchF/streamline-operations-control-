"""Эндпоинты справочников `[ТЗ 3.2.1]`.

Пути и форма ответа — по `openapi.yaml`: `/airports`, `/aircraft-types`,
`/vat-rates`, `/catalog/services`.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import Q, QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import filters, mixins, status, viewsets
from rest_framework.exceptions import ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from accounts.permissions import Permission
from audit import services as audit
from audit.models import AuditEntityType
from catalog import services as catalog_services
from catalog.api.serializers import (
    AircraftTypeSerializer,
    AirportCreateSerializer,
    AirportSerializer,
    ServiceSerializer,
    VatRateSerializer,
    VendorPriceCreateSerializer,
    VendorPriceSerializer,
)
from catalog.models import AircraftType, Airport, Service, VatRate, VendorPrice
from core.api.idempotency import IdempotentCreateMixin
from core.api.viewsets import ReferenceViewSet, SocViewSetMixin


@extend_schema_view(
    list=extend_schema(summary="Справочник аэропортов", tags=["catalog"]),
    create=extend_schema(summary="Добавление аэропорта", tags=["catalog"]),
)
class AirportViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/airports`.

    Читают все роли, у которых есть работа с рейсами или услугами: без
    аэропорта не прочитать ни расписание, ни заявку. Добавляет — только
    администратор справочников: ошибка в координатах или зоне расходится
    по всем рейсам через эту площадку.

    Удаления нет: аэропорт, через который прошёл хоть один рейс, не может
    исчезнуть из истории.
    """

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = Airport.objects.all()
    serializer_class = AirportSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.SCHEDULE_VIEW,
        "create": Permission.CATALOG_EDIT,
    }
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

    def get_serializer_class(self) -> type[BaseSerializer[Airport]]:
        if self.action == "create":
            return AirportCreateSerializer
        return AirportSerializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = AirportCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            airport = payload.save()
            audit.record(
                entity_type=AuditEntityType.AIRPORT,
                entity_id=airport.pk,
                action="created",
                actor=request.user,  # type: ignore[arg-type]
                after=audit.snapshot(airport),
            )
            return Response(
                AirportSerializer(airport).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)


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


@extend_schema_view(
    list=extend_schema(summary="Цены поставщиков по аэропортам", tags=["catalog"]),
    create=extend_schema(summary="Добавление цены поставщика", tags=["catalog"]),
)
class VendorPriceViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/catalog/prices` `[ТЗ 3.2.1]`.

    Закупочные цены видит не всякий: клиенту в портале они не показываются
    (`BILLING_PURCHASE_PRICE_VIEW`), и отделено это правом, а не фильтром
    на клиенте.

    Изменения цены нет и не будет: цена действует в периоде. Новые условия —
    это новый период, а правка задним числом переписала бы уже оформленные
    заявки, которые на неё ссылаются снимком.
    """

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = VendorPrice.objects.select_related("vendor", "service")
    serializer_class = VendorPriceSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_PURCHASE_PRICE_VIEW,
        "create": Permission.CATALOG_EDIT,
    }
    filter_backends = (filters.OrderingFilter,)
    ordering_fields = ("amount", "valid_from", "valid_to", "airport_icao")
    ordering = ("airport_icao", "service__code", "-valid_from")

    def get_queryset(self) -> QuerySet[VendorPrice]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("vendorId"):
            queryset = queryset.filter(vendor_id=params["vendorId"])
        if params.get("serviceId"):
            queryset = queryset.filter(service_id=params["serviceId"])
        if params.get("airportIcao"):
            queryset = queryset.filter(airport_icao=params["airportIcao"].upper())
        on_date = params.get("onDate")
        if on_date:
            # Действующие на указанную дату. Сравнение по дате, а не по
            # моменту: параметр контракта — date, и брать полночь UTC
            # означало бы терять цену, начинающуюся в тот же день позже.
            queryset = queryset.filter(valid_from__date__lte=on_date, valid_to__date__gte=on_date)
        return queryset

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = VendorPriceCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            minimum = data.get("minCharge")

            try:
                price = catalog_services.create_price(
                    vendor_id=data["vendorId"],
                    service_id=data["serviceId"],
                    airport_icao=data["airportIcao"],
                    amount=data["price"]["amount"],
                    currency=data["price"]["currency"],
                    min_charge_amount=minimum["amount"] if minimum else None,
                    valid_from=data["validFrom"],
                    valid_to=data["validTo"],
                    surcharges=_surcharges_payload(data["surcharges"]),
                    actor=request.user,  # type: ignore[arg-type]
                )
            except catalog_services.PriceOverlap as exc:
                raise ValidationError({"validFrom": str(exc)}) from exc

            return Response(
                VendorPriceSerializer(price).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)


def _surcharges_payload(surcharges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Надбавки в JSONB: суммы строками, `Decimal` в JSON не сериализуется."""
    return [
        {
            "code": surcharge["code"],
            "kind": surcharge["kind"],
            "value": str(surcharge["value"]),
            **({"appliesWhen": surcharge["appliesWhen"]} if "appliesWhen" in surcharge else {}),
        }
        for surcharge in surcharges
    ]
