"""Расчёты с поставщиками `[ТЗ 3.4.2]`.

`/payables`, `/payables/{id}/approve`, `/reconciliation/import`,
`/reconciliation/{id}`, `/reconciliation/{id}/resolve` — пути и формы
по `openapi.yaml`.

Поставщик видит свои заявки на оплату и только их: фильтр стоит
в `get_queryset()` (`BACKEND.md § 3.7`), поэтому чужая заявка даёт 404,
а не 403. Сверка порталам не показывается вовсе — это внутренний разбор
расхождений, а не переписка с поставщиком.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import generics, mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from billing.models import Payable, VendorInvoice
from billing.services import payables as payable_services
from billing.services import reconciliation as reconciliation_services
from core.api.idempotency import IdempotencyMixin
from core.api.pagination import SocPagination
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import TenantScopedViewSet
from counterparties.models import Vendor


class MoneySerializer(serializers.Serializer):  # type: ignore[type-arg]
    amount = serializers.CharField()
    currency = serializers.CharField()


class PayableSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`PayableItem` из контракта."""

    vendorId = serializers.CharField(source="vendor_id")  # noqa: N815
    vendorName = serializers.CharField(source="vendor.name")  # noqa: N815
    serviceOrderIds = serializers.SerializerMethodField()  # noqa: N815
    amount = serializers.SerializerMethodField()
    dueDate = serializers.DateTimeField(source="due_date")  # noqa: N815
    isOverdue = serializers.SerializerMethodField()  # noqa: N815
    vendorInvoiceId = serializers.CharField(  # noqa: N815
        source="vendor_invoice_id", allow_null=True
    )

    class Meta:
        model = Payable
        fields = (
            "id", "number", "vendorId", "vendorName", "serviceOrderIds",
            "amount", "dueDate", "status", "isOverdue", "vendorInvoiceId",
        )

    def get_serviceOrderIds(self, obj: Payable) -> list[str]:  # noqa: N802
        return [order.pk for order in obj.service_orders.all()]

    def get_amount(self, obj: Payable) -> dict[str, str]:
        from core.money import DISPLAY_QUANT

        return {
            "amount": str(obj.amount.quantize(DISPLAY_QUANT)),
            "currency": obj.currency,
        }

    def get_isOverdue(self, obj: Payable) -> bool:  # noqa: N802
        """Просрочку считает сервер.

        Считать её в браузере значило бы зависеть от часов рабочего места,
        а на стенде ещё и от модельного времени (ADR-014).
        """
        return obj.is_overdue()


class VendorInvoiceLineSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`VendorInvoiceLine` из контракта."""

    airportIcao = serializers.RegexField(r"^[A-Za-z]{4}$")  # noqa: N815
    serviceDate = serializers.DateTimeField()  # noqa: N815
    serviceCode = serializers.CharField(max_length=64)  # noqa: N815
    quantity = serializers.CharField()
    unitPrice = MoneySerializer()  # noqa: N815
    amount = MoneySerializer()


class VendorInvoiceImportSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`VendorInvoiceImport` из контракта."""

    vendorId = serializers.CharField()  # noqa: N815
    number = serializers.CharField(max_length=64)
    issuedAt = serializers.DateTimeField()  # noqa: N815
    currency = serializers.ChoiceField(choices=["RUB", "USD", "EUR"])
    # Счёт без строк сверять не с чем: пустой импорт — ошибка разбора
    # файла, а не законная операция.
    lines = serializers.ListField(child=VendorInvoiceLineSerializer(), min_length=1)


class VendorInvoiceSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`VendorInvoice` из контракта."""

    vendorId = serializers.CharField(source="vendor_id")  # noqa: N815
    issuedAt = serializers.DateTimeField(source="issued_at")  # noqa: N815
    lines = serializers.SerializerMethodField()
    unmappedCodes = serializers.JSONField(source="unmapped_codes")  # noqa: N815

    class Meta:
        model = VendorInvoice
        fields = (
            "id", "vendorId", "number", "issuedAt", "currency",
            "lines", "reconciliation", "unmappedCodes",
        )

    def get_lines(self, obj: VendorInvoice) -> list[dict[str, Any]]:
        return [
            {
                "airportIcao": line.airport_icao,
                "serviceDate": line.service_date.isoformat(),
                "serviceCode": line.service_code,
                "quantity": str(line.quantity),
                "unitPrice": {"amount": str(line.unit_price), "currency": obj.currency},
                "amount": {"amount": str(line.amount), "currency": obj.currency},
            }
            for line in obj.lines.all()
        ]


class ResolveDiscrepancySerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ResolveDiscrepancyRequest` из контракта."""

    discrepancyIndex = serializers.IntegerField(min_value=0)  # noqa: N815
    resolution = serializers.ChoiceField(choices=list(reconciliation_services.RESOLUTIONS))
    comment = serializers.CharField(required=False, allow_blank=True, default="")


@extend_schema_view(
    list=extend_schema(summary="Заявки на оплату поставщикам", tags=["billing"]),
)
class PayableViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/payables` `[ТЗ 3.4.2]`."""

    queryset = Payable.objects.select_related("vendor").prefetch_related("service_orders")
    serializer_class = PayableSerializer
    idempotency = "required"
    # Поставщик видит свои заявки: это его деньги, и портал для того и есть.
    tenant_vendor_field = "vendor_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_PAYABLES_VIEW,
        "approve": Permission.BILLING_PAYABLES_EDIT,
    }

    def get_queryset(self) -> QuerySet[Payable]:
        queryset = cast(QuerySet[Payable], super().get_queryset())
        params = self.request.query_params

        if params.get("vendorId"):
            queryset = queryset.filter(vendor_id=params["vendorId"])
        if params.get("status"):
            queryset = queryset.filter(status=params["status"])
        if params.get("overdue") in ("true", "1"):
            from billing.models import PayableStatus
            from core import clock

            queryset = queryset.filter(due_date__lt=clock.now()).exclude(
                status__in=[PayableStatus.PAID, PayableStatus.CANCELLED]
            )
        return queryset

    @extend_schema(
        summary="Согласование заявки на оплату",
        request=None,
        responses={
            200: PayableSerializer,
            404: ErrorResponseSerializer,
            409: ErrorResponseSerializer,
        },
        tags=["billing"],
    )
    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        payable = self.get_object()

        def produce() -> Response:
            approved = payable_services.approve(
                payable=payable, actor=cast(User, request.user)
            )
            return Response(PayableSerializer(approved).data)

        return self.idempotent(request, produce)


@extend_schema_view(
    get=extend_schema(summary="Импортированные счета поставщиков", tags=["billing"]),
)
class ReconciliationListView(generics.ListAPIView):  # type: ignore[type-arg]
    """`GET /api/v1/reconciliation` `[ТЗ 3.4.2]`.

    Реестр выполненных сверок. Без него импортированный счёт был бы
    доступен только по идентификатору из ответа на импорт и терялся бы
    при перезагрузке экрана.
    """

    serializer_class = VendorInvoiceSerializer
    pagination_class = SocPagination
    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "GET": Permission.BILLING_RECONCILIATION
    }

    def get_queryset(self) -> QuerySet[VendorInvoice]:
        queryset = VendorInvoice.objects.select_related("vendor").prefetch_related("lines")
        vendor_id = self.request.query_params.get("vendorId")
        if vendor_id:
            queryset = queryset.filter(vendor_id=vendor_id)
        return queryset


class ReconciliationImportView(IdempotencyMixin, APIView):
    """`POST /api/v1/reconciliation/import` `[ТЗ 3.4.2]`."""

    idempotency: ClassVar[str] = "required"
    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "POST": Permission.BILLING_RECONCILIATION
    }

    @extend_schema(
        summary="Импорт счёта поставщика для сверки",
        request=VendorInvoiceImportSerializer,
        responses={
            201: VendorInvoiceSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["billing"],
    )
    def post(self, request: Request) -> Response:
        def produce() -> Response:
            payload = VendorInvoiceImportSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            vendor = Vendor.objects.filter(pk=data["vendorId"]).first()
            if vendor is None:
                return Response(
                    {
                        "error": {
                            "code": "NOT_FOUND",
                            "message": "Поставщик не найден",
                            "details": {"vendorId": data["vendorId"]},
                        }
                    },
                    status=status.HTTP_404_NOT_FOUND,
                )

            invoice = reconciliation_services.import_invoice(
                vendor=vendor,
                number=data["number"],
                issued_at=data["issuedAt"],
                currency=data["currency"],
                payload=data["lines"],
                actor=cast(User, request.user),
            )
            return Response(
                VendorInvoiceSerializer(invoice).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)


class ReconciliationDetailView(APIView):
    """`GET /api/v1/reconciliation/{id}` `[ТЗ 3.4.2]`."""

    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "GET": Permission.BILLING_RECONCILIATION
    }

    @extend_schema(
        summary="Результат сверки с расхождениями",
        responses={200: VendorInvoiceSerializer, 404: ErrorResponseSerializer},
        tags=["billing"],
    )
    def get(self, request: Request, pk: str) -> Response:
        invoice = VendorInvoice.objects.filter(pk=pk).prefetch_related("lines").first()
        if invoice is None:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": "Сверка не найдена", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(VendorInvoiceSerializer(invoice).data)


class ReconciliationResolveView(IdempotencyMixin, APIView):
    """`POST /api/v1/reconciliation/{id}/resolve` `[ТЗ 3.4.2]`."""

    idempotency: ClassVar[str] = "required"
    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "POST": Permission.BILLING_RECONCILIATION
    }

    @extend_schema(
        summary="Решение по расхождению",
        request=ResolveDiscrepancySerializer,
        responses={
            200: VendorInvoiceSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
            409: ErrorResponseSerializer,
        },
        tags=["billing"],
    )
    def post(self, request: Request, pk: str) -> Response:
        invoice = VendorInvoice.objects.filter(pk=pk).first()
        if invoice is None:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": "Сверка не найдена", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )

        def produce() -> Response:
            payload = ResolveDiscrepancySerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            resolved = reconciliation_services.resolve(
                invoice=invoice,
                index=data["discrepancyIndex"],
                resolution=data["resolution"],
                comment=data["comment"],
                actor=cast(User, request.user),
            )
            return Response(VendorInvoiceSerializer(resolved).data)

        return self.idempotent(request, produce)
