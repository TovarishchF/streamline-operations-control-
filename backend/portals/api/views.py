"""Порталы клиента `[ТЗ 3.5.3]` и поставщика `[ТЗ 4.3]` (`SPEC.md § 8.4, 8.5`).

Отдельные представления, а не те же эндпоинты, урезанные на клиенте:
закупочных цен и данных поставщиков в ответе портала клиента нет
по построению сериализатора, и проверяется это тестом (приёмка M8).

Портал открыт только учётной записи, привязанной к своему клиенту или
поставщику, — выборка фильтруется по этой привязке на сервере
(`BACKEND.md § 3.7`). Сотрудник без привязки получает отказ: смотреть
систему глазами клиента — не то же самое, что видеть всех клиентов сразу.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.db.models import Prefetch, QuerySet
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from audit.models import AuditEntry
from billing.api.payables import PayableSerializer
from billing.models import Invoice, InvoiceStatus, Payable, Quote, QuoteStatus
from core.api.idempotency import IdempotencyMixin
from core.api.pagination import SocPagination
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from counterparties.api.serializers import VendorRatingSerializer
from counterparties.models import Client, Vendor
from counterparties.services import rating as rating_service
from flights.api.serializers import FlightRequestSerializer
from flights.models import Flight, FlightTemplate
from flights.services import planning
from orders.models import ServiceOrder, ServiceOrderStatus
from orders.services import costs


def _client_of(request: Request) -> Client:
    client = getattr(request.user, "client", None)
    if client is None:
        raise PermissionDenied("Портал клиента доступен учётной записи клиента")
    return cast(Client, client)


def _vendor_of(request: Request) -> Vendor:
    vendor = getattr(request.user, "vendor", None)
    if vendor is None:
        raise PermissionDenied("Портал поставщика доступен учётной записи поставщика")
    return cast(Vendor, vendor)


def _name(service: Any) -> dict[str, str]:
    return {"ru": service.name_ru, "en": service.name_en}


# ─────────────────────────── Портал клиента ───────────────────────────


class ClientPortalFlightSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`ClientPortalFlight`: рейс и статусы услуг — без поставщиков и цен."""

    depIcao = serializers.CharField(source="dep_icao")  # noqa: N815
    arrIcao = serializers.CharField(source="arr_icao")  # noqa: N815
    stdUtc = serializers.DateTimeField(source="std_utc")  # noqa: N815
    staUtc = serializers.DateTimeField(source="sta_utc")  # noqa: N815
    services = serializers.SerializerMethodField()

    class Meta:
        model = Flight
        fields = ("id", "number", "depIcao", "arrIcao", "stdUtc", "staUtc", "status", "services")

    def get_services(self, obj: Flight) -> list[dict[str, Any]]:
        # Отклонённая поставщиком заявка — наша внутренняя работа: её
        # заменяет новая, и клиенту видна услуга, а не история переназначений.
        return [
            {"serviceName": _name(order.service), "leg": order.leg, "status": order.status}
            for order in obj.service_orders.all()
            if order.status != ServiceOrderStatus.REJECTED
        ]


class ClientFlightsView(generics.ListAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/portal/client/flights`."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.SCHEDULE_VIEW}
    serializer_class = ClientPortalFlightSerializer
    pagination_class = SocPagination

    def get_queryset(self) -> QuerySet[Flight]:
        client = _client_of(self.request)
        return (
            Flight.objects.filter(client=client)
            .prefetch_related(
                Prefetch(
                    "service_orders",
                    queryset=ServiceOrder.objects.select_related("service").order_by(
                        "leg", "created_at"
                    ),
                )
            )
            .order_by("-std_utc")
        )

    @extend_schema(summary="Рейсы клиента", tags=["portal-client"])
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return super().get(request, *args, **kwargs)


class ClientPortalDocumentSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ClientPortalDocument`: котировка или счёт клиента."""

    id = serializers.CharField()
    kind = serializers.ChoiceField(choices=["quote", "invoice"])
    number = serializers.CharField()
    issuedAt = serializers.DateTimeField(allow_null=True)  # noqa: N815
    dueDate = serializers.DateTimeField(allow_null=True)  # noqa: N815
    status = serializers.CharField()
    total = serializers.DictField(child=serializers.CharField())


class ClientDocumentsView(generics.GenericAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/portal/client/documents`.

    Черновики не показываются: документ, ещё не выставленный клиенту,
    клиенту и не существует.
    """

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.BILLING_DOCUMENTS_VIEW}
    pagination_class = SocPagination

    @extend_schema(
        summary="Финансовые документы клиента",
        tags=["portal-client"],
        responses={200: ClientPortalDocumentSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        client = _client_of(request)
        documents: list[dict[str, Any]] = [
            {
                "id": quote.pk,
                "kind": "quote",
                "number": quote.number,
                "issuedAt": quote.issued_at,
                "dueDate": None,
                "status": quote.status,
                "total": {"amount": str(quote.total_amount), "currency": quote.currency},
            }
            for quote in Quote.objects.filter(client=client).exclude(status=QuoteStatus.DRAFT)
        ] + [
            {
                "id": invoice.pk,
                "kind": "invoice",
                "number": invoice.number,
                "issuedAt": invoice.issued_at,
                "dueDate": invoice.due_date,
                "status": invoice.status,
                "total": {"amount": str(invoice.total_amount), "currency": invoice.currency},
            }
            for invoice in Invoice.objects.filter(client=client).exclude(status=InvoiceStatus.DRAFT)
        ]
        documents.sort(key=lambda item: item["issuedAt"], reverse=True)
        page = self.paginate_queryset(documents)
        data = ClientPortalDocumentSerializer(page if page is not None else documents, many=True)
        if page is not None:
            return self.get_paginated_response(data.data)
        return Response(data.data)


class FlightRequestCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`FlightRequestCreate` из контракта."""

    depIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    arrIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    requestedStdUtc = serializers.DateTimeField()  # noqa: N815
    paxCount = serializers.IntegerField(min_value=0, max_value=500, default=0)  # noqa: N815
    templateId = serializers.CharField(required=False, allow_null=True, allow_blank=True)  # noqa: N815
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class ClientFlightRequestView(IdempotencyMixin, APIView):
    """`POST /api/v1/portal/client/flight-requests`.

    Рейсом заявка становится только после подтверждения диспетчером.
    """

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"POST": Permission.FLIGHT_REQUEST}
    idempotency = "required"

    @extend_schema(
        summary="Заявка клиента на рейс",
        tags=["portal-client"],
        request=FlightRequestCreateSerializer,
        responses={201: FlightRequestSerializer, 400: ErrorResponseSerializer},
    )
    def post(self, request: Request) -> Response:
        client = _client_of(request)

        def produce() -> Response:
            payload = FlightRequestCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            template = None
            if data.get("templateId"):
                template = FlightTemplate.objects.filter(pk=data["templateId"]).first()
                if template is None:
                    raise serializers.ValidationError({"templateId": "Шаблон не найден"})
            created = planning.submit_request(
                client=client,
                dep_icao=data["depIcao"],
                arr_icao=data["arrIcao"],
                requested_std_utc=data["requestedStdUtc"],
                pax_count=data["paxCount"],
                comment=data["comment"],
                template=template,
                actor=cast(User, request.user),
            )
            return Response(FlightRequestSerializer(created).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)


# ─────────────────────────── Портал поставщика ───────────────────────────


class VendorPortalOrderSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`VendorPortalOrder`: своя заявка — без чужих цен и без цены продажи клиенту."""

    serviceName = serializers.SerializerMethodField()  # noqa: N815
    airportIcao = serializers.CharField(source="airport_icao")  # noqa: N815
    flightNumber = serializers.CharField(source="flight.number")  # noqa: N815
    scheduledAt = serializers.SerializerMethodField()  # noqa: N815
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=True)
    agreedPrice = serializers.SerializerMethodField()  # noqa: N815
    slaConfirmDeadline = serializers.DateTimeField(  # noqa: N815
        source="sla_confirm_deadline", allow_null=True
    )
    dispatcherContact = serializers.SerializerMethodField()  # noqa: N815

    class Meta:
        model = ServiceOrder
        fields = (
            "id",
            "serviceName",
            "airportIcao",
            "flightNumber",
            "scheduledAt",
            "quantity",
            "attributes",
            "agreedPrice",
            "status",
            "slaConfirmDeadline",
            "dispatcherContact",
        )

    def get_serviceName(self, obj: ServiceOrder) -> dict[str, str]:  # noqa: N802
        return _name(obj.service)

    def get_scheduledAt(self, obj: ServiceOrder) -> str:  # noqa: N802
        moment = obj.flight.std_utc if obj.leg == "departure" else obj.flight.sta_utc
        return moment.isoformat()

    def get_agreedPrice(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        """Согласованная стоимость — снимок цены поставщика на плановое количество."""
        cost = costs.planned_cost(obj)
        return cost.to_json() if cost is not None else None

    def get_dispatcherContact(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        contacts: dict[str, dict[str, str]] = self.context.get("contacts", {})
        return contacts.get(obj.pk)


class VendorOrdersView(generics.ListAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/portal/vendor/orders`.

    Черновик поставщику не показывается: заявка ему ещё не отправлена.
    """

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.SERVICE_CONFIRM_OWN}
    serializer_class = VendorPortalOrderSerializer
    pagination_class = SocPagination

    def get_queryset(self) -> QuerySet[ServiceOrder]:
        vendor = _vendor_of(self.request)
        queryset = (
            ServiceOrder.objects.filter(vendor=vendor)
            .exclude(status=ServiceOrderStatus.DRAFT)
            .select_related("service", "flight")
            .order_by("-ordered_at")
        )
        if self.request.query_params.get("needsResponse") == "true":
            queryset = queryset.filter(status=ServiceOrderStatus.ORDERED)
        return queryset

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        page = self.paginate_queryset(self.get_queryset())
        orders = list(page) if page is not None else list(self.get_queryset())
        context = {**self.get_serializer_context(), "contacts": _ordering_contacts(orders)}
        data = VendorPortalOrderSerializer(orders, many=True, context=context).data
        return self.get_paginated_response(data) if page is not None else Response(data)

    @extend_schema(
        summary="Входящие заявки поставщика",
        tags=["portal-vendor"],
        parameters=[OpenApiParameter("needsResponse", bool, required=False)],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return super().get(request, *args, **kwargs)


def _ordering_contacts(orders: list[ServiceOrder]) -> dict[str, dict[str, str]]:
    """Кто оформил заявку — по журналу действий, одним запросом на страницу.

    Поставщику нужен живой человек, с которым говорить о заявке, а не
    общий адрес: журнал знает, кто её заказал.
    """
    # Последний, кто создал, заказал или назначил поставщика, — тот,
    # кто ведёт заявку сейчас.
    entries = AuditEntry.objects.filter(
        entity_id__in=[order.pk for order in orders],
        action__in=("created", "ordered", "vendor_assigned", "reassigned"),
    ).order_by("ts")
    actor_by_order = {entry.entity_id: entry.actor_id for entry in entries}
    users = {user.pk: user for user in User.objects.filter(pk__in=set(actor_by_order.values()))}
    contacts: dict[str, dict[str, str]] = {}
    for order_id, actor_id in actor_by_order.items():
        user = users.get(actor_id)
        if user is not None:
            contacts[order_id] = {
                "name": str(user.get_full_name() or user.username),
                "email": user.email,
            }
    return contacts


class VendorPayablesView(generics.ListAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/portal/vendor/payables`: свои заявки на оплату и их статусы."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.BILLING_PAYABLES_VIEW}
    serializer_class = PayableSerializer
    pagination_class = SocPagination

    def get_queryset(self) -> QuerySet[Payable]:
        vendor = _vendor_of(self.request)
        return (
            Payable.objects.filter(vendor=vendor)
            .select_related("vendor")
            .prefetch_related("service_orders")
            .order_by("due_date")
        )

    @extend_schema(summary="Заявки на оплату поставщика", tags=["portal-vendor"])
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return super().get(request, *args, **kwargs)


class VendorPerformanceView(APIView):
    """`GET /api/v1/portal/vendor/performance`: свой рейтинг с разложением."""

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.REPORTS_VENDOR_OWN}

    @extend_schema(
        summary="Показатели поставщика",
        tags=["portal-vendor"],
        responses={200: VendorRatingSerializer},
    )
    def get(self, request: Request) -> Response:
        vendor = _vendor_of(request)
        return Response(rating_service.to_contract(rating_service.rating_for(vendor)))
