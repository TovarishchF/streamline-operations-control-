"""Эндпоинты рейсов `[ТЗ 3.1]`.

Вьюха разбирает вход, вызывает сервис и возвращает результат
(`CLAUDE.md § 3` п. 10). Вся логика — в `flights.services`.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from audit.api.views import AuditEntrySerializer
from audit.models import AuditEntityType, AuditEntry
from catalog.models import Service
from core.api.idempotency import IdempotentCreateMixin
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import SocViewSetMixin, TenantScopedViewSet
from counterparties.models import Client, Vendor
from fleet.models import Aircraft
from flights.api.serializers import (
    ConflictSerializer,
    FlightCreateSerializer,
    FlightListSerializer,
    FlightRequestSerializer,
    FlightSerializer,
    FlightTemplateSerializer,
    FlightTransitionSerializer,
    FlightUpdateSerializer,
    GenerateSeriesSerializer,
    SlotAnswerSerializer,
    SlotCreateSerializer,
    SlotMessageSerializer,
    SlotSerializer,
    conflict_payload,
)
from flights.models import Flight, FlightRequest, FlightTemplate, Slot
from flights.services import conflicts as conflict_detector
from flights.services import generation, planning, transitions
from flights.services import slots as slot_services
from orders.api.serializers import ServiceOrderCreateSerializer, ServiceOrderSerializer
from orders.models import ServiceOrder
from orders.services import orders as order_services

# Горизонт поиска конфликтов по умолчанию. Дальше месяца расписание меняется
# столько раз, что предупреждать о конфликтах преждевременно.
CONFLICT_HORIZON_DAYS = 31


@extend_schema_view(
    list=extend_schema(
        summary="Суточный план",
        responses={200: FlightListSerializer(many=True), 403: ErrorResponseSerializer},
        tags=["flights"],
    ),
    retrieve=extend_schema(
        summary="Карточка рейса",
        responses={200: FlightSerializer, 404: ErrorResponseSerializer},
        tags=["flights"],
    ),
    create=extend_schema(
        summary="Создать рейс",
        request=FlightCreateSerializer,
        responses={
            201: FlightSerializer,
            400: ErrorResponseSerializer,
            403: ErrorResponseSerializer,
            409: ErrorResponseSerializer,
        },
        tags=["flights"],
    ),
    partial_update=extend_schema(
        summary="Изменить рейс",
        request=FlightUpdateSerializer,
        responses={
            200: FlightSerializer,
            404: ErrorResponseSerializer,
            409: ErrorResponseSerializer,
        },
        tags=["flights"],
    ),
)
class FlightViewSet(
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/flights`.

    Клиент видит только свои рейсы: фильтр стоит в `get_queryset()`
    (`BACKEND.md § 3.7`), поэтому чужой рейс даёт 404, а не 403.
    """

    queryset = Flight.objects.select_related(
        "client", "aircraft", "aircraft__type"
    ).prefetch_related("service_orders", "aircraft__approvals")
    serializer_class = FlightSerializer
    idempotency = "required"
    tenant_client_field = "client_id"
    http_method_names = ["get", "post", "patch", "head", "options"]  # noqa: RUF012
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.SCHEDULE_VIEW,
        "retrieve": Permission.SCHEDULE_VIEW,
        "create": Permission.FLIGHT_CREATE,
        "partial_update": Permission.FLIGHT_EDIT,
        "status": Permission.FLIGHT_STATUS,
        "history": Permission.SCHEDULE_VIEW,
        "services": Permission.SERVICE_ORDER,
    }

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return self.idempotent(request, lambda: self._create(request))

    def _create(self, request: Request) -> Response:
        payload = FlightCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        client = Client.objects.filter(pk=data["clientId"]).first()
        if client is None:
            from rest_framework.exceptions import ValidationError

            raise ValidationError({"clientId": "Клиент не найден"})

        aircraft = (
            Aircraft.objects.filter(pk=data["aircraftId"]).first()
            if data.get("aircraftId")
            else None
        )

        flight = planning.create_flight(
            client=client,
            dep_icao=data["depIcao"].upper(),
            arr_icao=data["arrIcao"].upper(),
            std_utc=data["stdUtc"],
            aircraft=aircraft,
            flight_type=data["type"],
            pax_count=data["paxCount"],
            remarks=data["remarks"],
            actor=cast(User, request.user),
        )
        return Response(FlightSerializer(flight).data, status=status.HTTP_201_CREATED)

    def get_serializer_class(self) -> type[Any]:
        return FlightListSerializer if self.action == "list" else FlightSerializer

    def get_queryset(self) -> QuerySet[Flight]:
        queryset = super().get_queryset()
        params = self.request.query_params

        if params.get("status"):
            queryset = queryset.filter(status__in=params["status"].split(","))
        if params.get("clientId"):
            queryset = queryset.filter(client_id=params["clientId"])
        if params.get("aircraftId"):
            queryset = queryset.filter(aircraft_id=params["aircraftId"])
        if params.get("from"):
            queryset = queryset.filter(std_utc__gte=params["from"])
        if params.get("to"):
            queryset = queryset.filter(std_utc__lte=params["to"])
        if params.get("airport"):
            from django.db.models import Q

            icao = params["airport"].upper()
            queryset = queryset.filter(Q(dep_icao=icao) | Q(arr_icao=icao))
        if params.get("type"):
            queryset = queryset.filter(type=params["type"])
        if params.get("search"):
            from django.db.models import Q

            needle = params["search"].strip()
            queryset = queryset.filter(
                Q(number__icontains=needle)
                | Q(dep_icao__istartswith=needle)
                | Q(arr_icao__istartswith=needle)
                | Q(client__name__icontains=needle)
                | Q(aircraft__registration__icontains=needle)
            )
        return queryset

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        flight = self.get_object()
        payload = FlightUpdateSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)

        mapping = {
            "aircraftId": "aircraft_id",
            "depIcao": "dep_icao",
            "arrIcao": "arr_icao",
            "stdUtc": "std_utc",
            "paxCount": "pax_count",
            "remarks": "remarks",
        }
        changes = {
            mapping[key]: value
            for key, value in payload.validated_data.items()
            if key in mapping
        }
        planning.update_route(flight, actor=cast(User, request.user), **changes)
        return Response(FlightSerializer(flight).data)

    @extend_schema(
        summary="Переход статуса рейса",
        request=FlightTransitionSerializer,
        responses={200: FlightSerializer, 409: ErrorResponseSerializer},
        tags=["flights"],
    )
    @action(detail=True, methods=["post"], url_path="status")
    def status(self, request: Request, pk: str | None = None) -> Response:
        flight = self.get_object()
        payload = FlightTransitionSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        transitions.apply_transition(
            flight,
            payload.validated_data["transition"],
            actor=cast(User, request.user),
            reason_code=payload.validated_data["reasonCode"],
            comment=payload.validated_data["comment"],
        )
        return Response(FlightSerializer(flight).data)

    @extend_schema(
        summary="Заявки на услуги рейса",
        request=ServiceOrderCreateSerializer,
        responses={
            200: ServiceOrderSerializer(many=True),
            201: ServiceOrderSerializer,
            400: ErrorResponseSerializer,
            # Провал блокирующих проверок SPEC § 5.2 — это не ошибка запроса,
            # а отказ по существу: 422 с перечнем непройденных проверок.
            422: ErrorResponseSerializer,
        },
        tags=["orders"],
    )
    @action(detail=True, methods=["get", "post"], url_path="services")
    def services(self, request: Request, pk: str | None = None) -> Response:
        """`GET|POST /api/v1/flights/{id}/services` `[ТЗ 3.2.2]`.

        Путь вложен в рейс, потому что владение заявкой определяется рейсом:
        фильтрация по арендатору уже сделана в `get_queryset()` этого вьюсета,
        и отдельный вьюсет пришлось бы учить ей заново.
        """
        flight = self.get_object()

        if request.method == "GET":
            queryset = (
                ServiceOrder.objects.filter(flight=flight)
                .select_related("service", "vendor", "contract", "flight")
                .prefetch_related("documents")
            )
            return Response({"data": ServiceOrderSerializer(queryset, many=True).data})

        return self.idempotent(request, lambda: self._create_service_order(request, flight))

    def _create_service_order(self, request: Request, flight: Flight) -> Response:
        payload = ServiceOrderCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        vendor_id = data.get("vendorId")
        order = order_services.create_order(
            flight=flight,
            service=Service.objects.get(pk=data["serviceId"]),
            leg=data["leg"],
            quantity=data["quantity"],
            vendor=Vendor.objects.get(pk=vendor_id) if vendor_id else None,
            attributes=data["attributes"],
            override_reason=data["overrideReason"],
            actor=cast(User, request.user),
        )
        return Response(ServiceOrderSerializer(order).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="История изменений рейса",
        responses={200: AuditEntrySerializer(many=True)},
        tags=["flights"],
    )
    @action(detail=True, methods=["get"])
    def history(self, request: Request, pk: str | None = None) -> Response:
        flight = self.get_object()
        entries = AuditEntry.objects.filter(
            entity_type=AuditEntityType.FLIGHT, entity_id=flight.pk
        )
        return Response({"data": AuditEntrySerializer(entries, many=True).data})


class ScheduleConflictsView(APIView):
    """`GET /api/v1/flights/conflicts`.

    Конфликты считаются на лету, а не хранятся: они зависят от состояния
    борта и соседних рейсов, и сохранённый список устаревал бы при каждой
    правке расписания.
    """

    permission_classes = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {"GET": Permission.SCHEDULE_VIEW}

    @extend_schema(
        summary="Конфликты расписания",
        responses={200: ConflictSerializer(many=True)},
        tags=["flights"],
    )
    def get(self, request: Request) -> Response:
        from core import clock

        since = clock.now()
        until = since + timedelta(days=CONFLICT_HORIZON_DAYS)

        flights = (
            Flight.objects.filter(std_utc__gte=since, std_utc__lte=until)
            .select_related("aircraft", "aircraft__type")
            .prefetch_related("aircraft__approvals")
        )

        found: list[dict[str, Any]] = []
        for flight in flights:
            found.extend(
                conflict_payload(flight, item) for item in conflict_detector.detect(flight)
            )
        return Response({"data": found})


@extend_schema_view(
    list=extend_schema(summary="Шаблоны рейсов", tags=["flights"]),
    create=extend_schema(summary="Создать шаблон", tags=["flights"]),
)
class FlightTemplateViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/flight-templates`."""

    queryset = FlightTemplate.objects.filter(is_active=True).prefetch_related(
        "default_services"
    )
    serializer_class = FlightTemplateSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.SCHEDULE_VIEW,
        "create": Permission.FLIGHT_CREATE,
        "generate": Permission.FLIGHT_CREATE,
    }

    @extend_schema(
        summary="Сгенерировать серию рейсов",
        request=GenerateSeriesSerializer,
        responses={
            200: FlightListSerializer(many=True),
            201: FlightListSerializer(many=True),
        },
        tags=["flights"],
    )
    @action(detail=True, methods=["post"])
    def generate(self, request: Request, pk: str | None = None) -> Response:
        template = self.get_object()
        payload = GenerateSeriesSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        created = generation.generate(
            template,
            payload.validated_data["fromDate"],
            payload.validated_data["toDate"],
            actor=cast(User, request.user),
        )
        return Response(
            {"data": FlightListSerializer(created, many=True).data},
            status=status.HTTP_201_CREATED,
        )


@extend_schema_view(list=extend_schema(summary="Заявки клиентов на рейс", tags=["flights"]))
class FlightRequestViewSet(
    mixins.ListModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/flight-requests`.

    Клиент подаёт заявку, диспетчер её рассматривает (`SPEC § 2.2`, сноска).
    Клиент видит только свои заявки.
    """

    queryset = FlightRequest.objects.select_related("client")
    serializer_class = FlightRequestSerializer
    tenant_client_field = "client_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.SCHEDULE_VIEW,
        "approve": Permission.REQUEST_APPROVE,
        "reject": Permission.REQUEST_APPROVE,
    }

    def get_queryset(self) -> QuerySet[FlightRequest]:
        queryset = super().get_queryset()
        if self.request.query_params.get("status"):
            queryset = queryset.filter(status=self.request.query_params["status"])
        return queryset

    @extend_schema(
        summary="Подтвердить заявку и создать рейс",
        request=None,
        responses={201: FlightSerializer},
        tags=["flights"],
    )
    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        flight_request = self.get_object()
        flight = planning.approve_request(flight_request, actor=cast(User, request.user))
        return Response(FlightSerializer(flight).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Отклонить заявку",
        request=None,
        responses={200: FlightRequestSerializer},
        tags=["flights"],
    )
    @action(detail=True, methods=["post"])
    def reject(self, request: Request, pk: str | None = None) -> Response:
        flight_request = self.get_object()
        reason = str(request.data.get("reason", "")).strip()
        planning.reject_request(flight_request, reason, actor=cast(User, request.user))
        return Response(FlightRequestSerializer(flight_request).data)


@extend_schema_view(
    list=extend_schema(summary="Реестр слотов", tags=["flights"]),
    create=extend_schema(
        summary="Запрос слота",
        request=SlotCreateSerializer,
        responses={
            201: SlotSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["flights"],
    ),
)
class SlotViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/slots` (ADR-026).

    Подключения к системам слот-координации не существует: координаторы
    работают сообщениями по почте. Здесь ведётся реестр, формирование
    сообщений SCR — M14.
    """

    queryset = Slot.objects.select_related("flight", "flight__aircraft__type")
    serializer_class = SlotSerializer
    idempotency = "optional"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.SCHEDULE_VIEW,
        "create": Permission.FLIGHT_EDIT,
        "scr": Permission.FLIGHT_EDIT,
        "apply": Permission.FLIGHT_EDIT,
    }

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = SlotCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            flight = Flight.objects.filter(pk=data["flightId"]).first()
            if flight is None:
                return Response(
                    {
                        "error": {
                            "code": "NOT_FOUND",
                            "message": "Рейс не найден",
                            "details": {"flightId": data["flightId"]},
                        }
                    },
                    status=status.HTTP_404_NOT_FOUND,
                )

            slot = slot_services.request_slot(
                flight=flight,
                airport_icao=data["airportIcao"],
                slot_type=data["kind"],
                requested_utc=data["requestedTimeUtc"],
                actor=cast(User, request.user),
            )
            return Response(SlotSerializer(slot).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Черновик сообщения SCR",
        request=None,
        responses={200: SlotMessageSerializer, 404: ErrorResponseSerializer},
        tags=["flights"],
    )
    @action(detail=True, methods=["post"])
    def scr(self, request: Request, pk: str | None = None) -> Response:
        """Собирает черновик сообщения координатору (ADR-026).

        Сообщение не уходит само: подключения к слот-координации нет,
        и это инструмент подготовки переписки. Диспетчер правит текст
        и отправляет его сам.
        """
        slot, text = slot_services.prepare_scr(
            slot=self.get_object(), actor=cast(User, request.user)
        )
        return Response({"messageRef": slot.message_number, "text": text})

    @extend_schema(
        summary="Применение ответа координатора",
        request=SlotAnswerSerializer,
        responses={
            200: SlotSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
            409: ErrorResponseSerializer,
        },
        tags=["flights"],
    )
    @action(detail=True, methods=["post"])
    def apply(self, request: Request, pk: str | None = None) -> Response:
        """Применяет ответ координатора `[ТЗ 3.1.1]`."""
        slot = self.get_object()

        def produce() -> Response:
            payload = SlotAnswerSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            applied = slot_services.apply_answer(
                slot=slot,
                actor=cast(User, request.user),
                status=data["status"],
                confirmed_utc=data["confirmedTimeUtc"],
                text=data["text"],
            )
            return Response(SlotSerializer(applied).data)

        return self.idempotent(request, produce)

    def get_queryset(self) -> QuerySet[Slot]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("flightId"):
            queryset = queryset.filter(flight_id=params["flightId"])
        if params.get("airportIcao"):
            queryset = queryset.filter(airport_icao=params["airportIcao"])
        if params.get("status"):
            queryset = queryset.filter(status=params["status"])
        return queryset
