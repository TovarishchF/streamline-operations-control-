"""Эндпоинты заявок на услуги `[ТЗ 3.2.2, 3.2.3]`.

`/service-orders`, `/service-orders/{id}`, `/service-orders/{id}/status`,
`/service-orders/{id}/reassign`, `/service-orders/{id}/documents` —
пути и формы по `openapi.yaml`.

Выборка ограничена арендатором (`BACKEND.md § 3.7`): поставщик видит только
свои заявки, клиент — только заявки по своим рейсам. Фильтр стоит
в `get_queryset()`, а не в проверке объекта: проверка объекта закрывает
карточку, а списочный эндпоинт при этом отдаёт чужое.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, status
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import Permission
from core.api.attachments import AttachmentRefSerializer
from core.api.idempotency import IdempotencyMixin
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import TenantScopedViewSet
from core.models import AttachmentKind
from core.services import attachments as attachment_service
from core.services import storage
from counterparties.models import Vendor
from orders.api.serializers import (
    ServiceOrderReassignSerializer,
    ServiceOrderSerializer,
    ServiceOrderTransitionSerializer,
    ServiceOrderUpdateSerializer,
)
from orders.models import ServiceOrder
from orders.services import orders as order_services
from orders.services import transitions

# Поля запроса в поля модели. Список явный: `setattr` по произвольному
# имени из тела запроса — это способ записать что угодно куда угодно.
UPDATABLE_FIELDS = {
    "quantity": "quantity",
    "actualQuantity": "actual_quantity",
    "actualStartAt": "actual_start_at",
    "actualEndAt": "actual_end_at",
    "attributes": "attributes",
}


@extend_schema_view(
    list=extend_schema(summary="Список заявок на услуги", tags=["orders"]),
    retrieve=extend_schema(
        summary="Карточка заявки",
        tags=["orders"],
        responses={200: ServiceOrderSerializer, 404: ErrorResponseSerializer},
    ),
    partial_update=extend_schema(summary="Изменение заявки", tags=["orders"]),
)
class ServiceOrderViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/service-orders`."""

    http_method_names = ["get", "post", "patch", "head", "options"]  # noqa: RUF012
    queryset = ServiceOrder.objects.select_related(
        "flight", "service", "vendor", "contract"
    ).prefetch_related("documents")
    serializer_class = ServiceOrderSerializer
    idempotency = "required"
    tenant_vendor_field = "vendor_id"
    tenant_client_field = "flight__client_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        # Диспетчер и финансист приходят сюда по праву на каталог,
        # поставщик — по праву на свои заявки. Чужие записи отсекает
        # фильтрация выборки, а не право (`BACKEND.md § 3.7`).
        "list": (Permission.CATALOG_VIEW, Permission.SERVICE_CONFIRM_OWN),
        "retrieve": (Permission.CATALOG_VIEW, Permission.SERVICE_CONFIRM_OWN),
        "partial_update": Permission.SERVICE_ORDER,
        "status": (Permission.SERVICE_CONFIRM, Permission.SERVICE_CONFIRM_OWN),
        "reassign": Permission.VENDOR_ASSIGN,
        "documents": (Permission.SERVICE_CONFIRM, Permission.SERVICE_CONFIRM_OWN),
    }

    def get_queryset(self) -> QuerySet[ServiceOrder]:
        queryset = super().get_queryset()
        params = self.request.query_params

        statuses = params.getlist("status")
        if statuses:
            queryset = queryset.filter(status__in=statuses)
        if params.get("flightId"):
            queryset = queryset.filter(flight_id=params["flightId"])
        if params.get("vendorId"):
            queryset = queryset.filter(vendor_id=params["vendorId"])
        if params.get("slaBreached") in ("true", "false"):
            queryset = queryset.filter(sla_breached=params["slaBreached"] == "true")
        if params.get("needsResponse") == "true":
            # Требуют ответа поставщика: заказаны и ещё не подтверждены.
            queryset = queryset.filter(status="ordered")
        return queryset

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        order = self.get_object()
        payload = ServiceOrderUpdateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        if "vendorId" in data:
            order = order_services.assign_vendor(
                order=order,
                vendor=Vendor.objects.get(pk=data["vendorId"]),
                actor=cast(User, request.user),
            )

        changes = {
            field: data[source] for source, field in UPDATABLE_FIELDS.items() if source in data
        }
        if changes:
            order = order_services.update_order(
                order=order, changes=changes, actor=cast(User, request.user)
            )

        return Response(ServiceOrderSerializer(order).data)

    @extend_schema(
        summary="Переход статуса заявки",
        request=ServiceOrderTransitionSerializer,
        responses={200: ServiceOrderSerializer, 409: ErrorResponseSerializer},
        tags=["orders"],
    )
    @action(detail=True, methods=["post"], url_path="status")
    def status(self, request: Request, pk: str | None = None) -> Response:
        order = self.get_object()
        payload = ServiceOrderTransitionSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        # Факт принимается вместе с переходом: иначе между сохранением
        # карточки и нажатием «Выполнена» заявка была бы в состоянии,
        # которого автомат не допускает.
        factual = {
            field: data[source]
            for source, field in (
                ("actualStartAt", "actual_start_at"),
                ("actualEndAt", "actual_end_at"),
                ("actualQuantity", "actual_quantity"),
            )
            if source in data
        }
        if factual:
            order = order_services.update_order(
                order=order, changes=factual, actor=cast(User, request.user)
            )

        transitions.apply_transition(
            order,
            data["transition"],
            actor=cast(User, request.user),
            comment=data["comment"] or data["reasonCode"],
        )
        return Response(ServiceOrderSerializer(order).data)

    @extend_schema(
        summary="Переназначение поставщика после отказа",
        request=ServiceOrderReassignSerializer,
        responses={201: ServiceOrderSerializer, 400: ErrorResponseSerializer},
        tags=["orders"],
    )
    @action(detail=True, methods=["post"])
    def reassign(self, request: Request, pk: str | None = None) -> Response:
        order = self.get_object()

        def produce() -> Response:
            payload = ServiceOrderReassignSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            replacement = order_services.reassign(
                order=order,
                vendor=Vendor.objects.get(pk=payload.validated_data["vendorId"]),
                comment=payload.validated_data["comment"],
                actor=cast(User, request.user),
            )
            return Response(
                ServiceOrderSerializer(replacement).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Получение ссылки для загрузки документа",
        request=None,
        responses={201: AttachmentRefSerializer},
        tags=["orders"],
    )
    @action(detail=True, methods=["post"])
    def documents(self, request: Request, pk: str | None = None) -> Response:
        """Ссылка на загрузку документа по заявке `[ТЗ 3.2.3]`.

        В отличие от общего `POST /attachments`, вложение сразу привязано
        к заявке: акт, загруженный и не привязанный, не откроет переход
        в «Выполнена», и разбираться с этим пришлось бы у стойки.
        """
        order = self.get_object()

        def produce() -> Response:
            attachment, upload_url = attachment_service.reserve(
                file_name=request.data.get("fileName", ""),
                mime_type=request.data.get("mimeType", ""),
                size_bytes=int(request.data.get("sizeBytes", 0)),
                kind=request.data.get("kind", AttachmentKind.ACT),
                actor=cast(User, request.user),
            )
            # Привязка сразу, до загрузки: акт, загруженный и не привязанный,
            # не откроет переход в «Выполнена», и разбираться с этим пришлось
            # бы у стойки.
            attachment_service.link(attachment=attachment, owner=order)
            return Response(
                {
                    "attachment": AttachmentRefSerializer(attachment).data,
                    "uploadUrl": upload_url,
                    "expiresInSeconds": storage.UPLOAD_URL_TTL_SECONDS,
                },
                status=status.HTTP_201_CREATED,
            )

        return self.idempotent(request, produce)

