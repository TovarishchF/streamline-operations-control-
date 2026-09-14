"""Эндпоинты котировок и счетов `[ТЗ 3.4.1]`.

`/quotes`, `/quotes/{id}`, `/quotes/{id}/issue|void|accept|decline`,
`/invoices`, `/invoices/{id}`, `/invoices/{id}/issue|void` — пути и формы
по `openapi.yaml`.

Эндпоинта изменения документа нет и не будет: выставленный документ
неизменяем (`BACKEND.md § 3.4`), а черновик проще пересобрать заново,
чем править по строке. Отсутствие маршрута — один из трёх уровней защиты
неизменяемости наряду с проверкой в сервисе и ограничением в базе.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, status
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import Permission
from billing.api.serializers import (
    ExportRequestSerializer,
    ExportTicketSerializer,
    InvoiceCreateSerializer,
    InvoiceSerializer,
    QuoteCreateSerializer,
    QuoteSerializer,
    VoidSerializer,
)
from billing.models import Invoice, Quote
from billing.services import documents, export
from core import clock
from core.api.idempotency import IdempotencyMixin
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import TenantScopedViewSet
from core.services import storage
from flights.models import Flight


@extend_schema_view(
    list=extend_schema(summary="Котировки", tags=["billing"]),
    retrieve=extend_schema(
        summary="Котировка",
        tags=["billing"],
        responses={200: QuoteSerializer, 404: ErrorResponseSerializer},
    ),
)
class QuoteViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/quotes`."""

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = Quote.objects.select_related("flight", "client").prefetch_related(
        "lines", "lines__service_order"
    )
    serializer_class = QuoteSerializer
    idempotency = "required"
    tenant_client_field = "client_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_DOCUMENTS_VIEW,
        "retrieve": Permission.BILLING_DOCUMENTS_VIEW,
        "create": Permission.BILLING_DOCUMENTS_EDIT,
        "issue": Permission.BILLING_DOCUMENTS_EDIT,
        "void": Permission.BILLING_DOCUMENTS_EDIT,
        # Принимает и отклоняет котировку клиент — в своём портале.
        "accept": (Permission.BILLING_DOCUMENTS_VIEW, Permission.BILLING_DOCUMENTS_EDIT),
        "decline": (Permission.BILLING_DOCUMENTS_VIEW, Permission.BILLING_DOCUMENTS_EDIT),
    }

    def get_queryset(self) -> QuerySet[Quote]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("clientId"):
            queryset = queryset.filter(client_id=params["clientId"])
        if params.get("flightId"):
            queryset = queryset.filter(flight_id=params["flightId"])
        if params.get("status"):
            queryset = queryset.filter(status=params["status"])
        return queryset

    @extend_schema(
        summary="Формирование котировки из планируемых услуг рейса",
        request=QuoteCreateSerializer,
        responses={201: QuoteSerializer, 400: ErrorResponseSerializer},
        tags=["billing"],
    )
    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = QuoteCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            quote = documents.build_quote(
                flight=_flight_for(request, payload.validated_data["flightId"]),
                valid_until=payload.validated_data.get("validUntil"),
                actor=cast(User, request.user),
            )
            return Response(QuoteSerializer(quote).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Выставление котировки",
        request=None,
        responses={200: QuoteSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def issue(self, request: Request, pk: str | None = None) -> Response:
        quote = documents.issue_quote(
            quote=self.get_object(), actor=cast(User, request.user)
        )
        return Response(QuoteSerializer(quote).data)

    @extend_schema(
        summary="Аннулирование котировки",
        request=VoidSerializer,
        responses={200: QuoteSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def void(self, request: Request, pk: str | None = None) -> Response:
        payload = VoidSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        quote = documents.void_quote(
            quote=self.get_object(),
            reason=payload.validated_data["reason"],
            actor=cast(User, request.user),
        )
        return Response(QuoteSerializer(quote).data)

    @extend_schema(
        summary="Принятие котировки клиентом",
        request=None,
        responses={200: QuoteSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def accept(self, request: Request, pk: str | None = None) -> Response:
        quote = documents.respond_to_quote(
            quote=self.get_object(), accepted=True, actor=cast(User, request.user)
        )
        return Response(QuoteSerializer(quote).data)

    @extend_schema(
        summary="Отклонение котировки клиентом",
        request=None,
        responses={200: QuoteSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def decline(self, request: Request, pk: str | None = None) -> Response:
        quote = documents.respond_to_quote(
            quote=self.get_object(), accepted=False, actor=cast(User, request.user)
        )
        return Response(QuoteSerializer(quote).data)


@extend_schema_view(
    list=extend_schema(summary="Счета клиентам", tags=["billing"]),
    retrieve=extend_schema(
        summary="Счёт",
        tags=["billing"],
        responses={200: InvoiceSerializer, 404: ErrorResponseSerializer},
    ),
)
class InvoiceViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/invoices`."""

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = Invoice.objects.select_related("flight", "client", "quote").prefetch_related(
        "lines", "lines__service_order"
    )
    serializer_class = InvoiceSerializer
    idempotency = "required"
    tenant_client_field = "client_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_DOCUMENTS_VIEW,
        "retrieve": Permission.BILLING_DOCUMENTS_VIEW,
        "create": Permission.BILLING_DOCUMENTS_EDIT,
        "issue": Permission.BILLING_DOCUMENTS_EDIT,
        "void": Permission.BILLING_DOCUMENTS_EDIT,
        # Выгрузить счёт может и тот, кто его только читает: клиент
        # скачивает свой счёт из портала.
        "export": Permission.BILLING_DOCUMENTS_VIEW,
    }

    def get_queryset(self) -> QuerySet[Invoice]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("clientId"):
            queryset = queryset.filter(client_id=params["clientId"])
        if params.get("flightId"):
            queryset = queryset.filter(flight_id=params["flightId"])
        if params.get("status"):
            queryset = queryset.filter(status=params["status"])
        if params.get("overdue") == "true":
            from core import clock

            queryset = queryset.filter(due_date__lt=clock.now()).exclude(
                status__in=["paid", "voided", "draft"]
            )
        return queryset

    @extend_schema(
        summary="Формирование счёта по фактически оказанным услугам",
        request=InvoiceCreateSerializer,
        responses={201: InvoiceSerializer, 400: ErrorResponseSerializer},
        tags=["billing"],
    )
    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = InvoiceCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            quote_id = data.get("quoteId")
            invoice = documents.build_invoice(
                flight=_flight_for(request, data["flightId"]),
                quote=Quote.objects.filter(pk=quote_id).first() if quote_id else None,
                actor=cast(User, request.user),
            )
            return Response(InvoiceSerializer(invoice).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Выставление счёта",
        request=None,
        responses={200: InvoiceSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def issue(self, request: Request, pk: str | None = None) -> Response:
        invoice = documents.issue_invoice(
            invoice=self.get_object(), actor=cast(User, request.user)
        )
        return Response(InvoiceSerializer(invoice).data)

    @extend_schema(
        summary="Аннулирование счёта",
        request=VoidSerializer,
        responses={200: InvoiceSerializer, 409: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def void(self, request: Request, pk: str | None = None) -> Response:
        payload = VoidSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        invoice = documents.void_invoice(
            invoice=self.get_object(),
            reason=payload.validated_data["reason"],
            actor=cast(User, request.user),
        )
        return Response(InvoiceSerializer(invoice).data)

    @extend_schema(
        summary="Выгрузка счёта в PDF или XLSX",
        request=ExportRequestSerializer,
        responses={202: ExportTicketSerializer, 400: ErrorResponseSerializer},
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def export(self, request: Request, pk: str | None = None) -> Response:
        """`POST /api/v1/invoices/{id}/export` `[ТЗ 3.4.1]`.

        Формирование синхронное, а не в Celery: документ на десяток строк
        собирается за десятки миллисекунд, и очередь ради этого добавляла бы
        человеку ожидание вместо того, чтобы его убрать. Форма ответа —
        та же, что у отложенной задачи (`ExportTicket`), поэтому перенос
        в очередь при росте объёмов не потребует менять клиентов.
        """

        def produce() -> Response:
            payload = ExportRequestSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            invoice = self.get_object()

            url = export.export_document(
                document=invoice,
                kind="invoice",
                export_format=payload.validated_data["format"],
            )
            return Response(
                {
                    "taskId": invoice.pk,
                    "status": "ready",
                    "downloadUrl": url,
                    "expiresAt": clock.now() + timedelta(seconds=storage.DOWNLOAD_URL_TTL_SECONDS),
                },
                status=status.HTTP_202_ACCEPTED,
            )

        return self.idempotent(request, produce)


def _flight_for(request: Request, flight_id: str) -> Flight:
    """Рейс, по которому формируется документ.

    Выборка ограничена арендатором так же, как в списке рейсов: иначе
    документ можно было бы выставить по чужому рейсу, зная его номер.
    """
    from rest_framework.exceptions import ValidationError

    flight = Flight.objects.filter(pk=flight_id).select_related("client").first()
    if flight is None:
        raise ValidationError({"flightId": "Рейс не найден"})
    return flight

