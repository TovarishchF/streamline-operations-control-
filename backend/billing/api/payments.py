"""Поступления от клиентов `[ТЗ 3.4.1]` (ADR-019).

`/payments` — пути и формы по `openapi.yaml`. Платёж не правится и не
удаляется: ошибочное поступление исправляется обратной проводкой в учётной
системе, а не стиранием истории. Клиент видит свои платежи — фильтр
арендатора в `get_queryset()` (`BACKEND.md § 3.7`).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, serializers, status
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import Permission
from billing.api.serializers import PlainMoneySerializer
from billing.models import Invoice, Payment, PaymentSource
from billing.services import payments
from core.api.idempotency import IdempotencyMixin
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import TenantScopedViewSet
from core.money import Money
from counterparties.models import Client


class AllocationSerializer(serializers.Serializer):  # type: ignore[type-arg]
    invoiceId = serializers.CharField()  # noqa: N815
    amount = PlainMoneySerializer()


class PaymentCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`PaymentCreate` из контракта."""

    clientId = serializers.CharField()  # noqa: N815
    amount = PlainMoneySerializer()
    receivedAt = serializers.DateTimeField()  # noqa: N815
    allocations = AllocationSerializer(many=True, required=False, default=list)
    externalId = serializers.CharField(required=False, allow_blank=True, default="")  # noqa: N815
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def get_fields(self) -> dict[str, serializers.Field]:  # type: ignore[type-arg]
        # `source` совпадает с атрибутом базового класса поля, поэтому
        # объявляется через словарь полей: имя задано контрактом.
        fields = super().get_fields()
        fields["source"] = serializers.ChoiceField(
            choices=PaymentSource.choices, default=PaymentSource.MANUAL
        )
        return fields

    def validate_amount(self, value: dict[str, Any]) -> dict[str, Any]:
        if Decimal(value["amount"]) <= 0:
            raise serializers.ValidationError("Сумма платежа должна быть больше нуля")
        return value

    def validate_allocations(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for item in value:
            if Decimal(item["amount"]["amount"]) <= 0:
                raise serializers.ValidationError("Сумма распределения должна быть больше нуля")
        return value


class PaymentSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`Payment` из контракта."""

    clientId = serializers.CharField(source="client_id")  # noqa: N815
    amount = serializers.SerializerMethodField()
    receivedAt = serializers.DateTimeField(source="received_at")  # noqa: N815
    allocations = serializers.SerializerMethodField()
    externalId = serializers.CharField(source="external_id")  # noqa: N815
    fxRate = serializers.SerializerMethodField()  # noqa: N815
    createdAt = serializers.DateTimeField(source="created_at")  # noqa: N815

    class Meta:
        model = Payment
        fields = (
            "id", "clientId", "amount", "receivedAt", "allocations", "source",
            "externalId", "comment", "fxRate", "createdAt",
        )

    def get_amount(self, obj: Payment) -> dict[str, str]:
        return {"amount": str(obj.amount), "currency": obj.currency}

    def get_allocations(self, obj: Payment) -> list[dict[str, Any]]:
        return [
            {
                "invoiceId": item.invoice_id,
                "amount": {"amount": str(item.amount), "currency": item.currency},
            }
            for item in obj.allocations.all()
        ]

    def get_fxRate(self, obj: Payment) -> str | None:  # noqa: N802
        return f"{obj.fx_rate:.4f}" if obj.fx_rate is not None else None


@extend_schema_view(
    list=extend_schema(summary="Поступления от клиентов", tags=["billing"]),
)
class PaymentViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    TenantScopedViewSet,
):
    """`/api/v1/payments`."""

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = Payment.objects.select_related("client").prefetch_related("allocations")
    serializer_class = PaymentSerializer
    idempotency = "required"
    tenant_client_field = "client_id"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_DOCUMENTS_VIEW,
        "create": Permission.BILLING_DOCUMENTS_EDIT,
    }

    def get_queryset(self) -> QuerySet[Payment]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("clientId"):
            queryset = queryset.filter(client_id=params["clientId"])
        if params.get("invoiceId"):
            queryset = queryset.filter(allocations__invoice_id=params["invoiceId"]).distinct()
        return queryset

    @extend_schema(
        summary="Регистрация поступления",
        request=PaymentCreateSerializer,
        responses={201: PaymentSerializer, 400: ErrorResponseSerializer},
        tags=["billing"],
    )
    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = PaymentCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            client = Client.objects.filter(pk=data["clientId"]).first()
            if client is None:
                raise serializers.ValidationError({"clientId": "Клиент не найден"})

            allocations = []
            for item in data["allocations"]:
                invoice = Invoice.objects.filter(pk=item["invoiceId"]).first()
                if invoice is None:
                    raise serializers.ValidationError(
                        {"allocations": f"Счёт {item['invoiceId']} не найден"}
                    )
                allocations.append(
                    payments.AllocationRequest(
                        invoice=invoice,
                        amount=Money.of(item["amount"]["amount"], item["amount"]["currency"]),
                    )
                )

            payment = payments.register(
                client=client,
                amount=Money.of(data["amount"]["amount"], data["amount"]["currency"]),
                received_at=data["receivedAt"],
                allocations=allocations,
                source=data["source"],
                external_id=data["externalId"],
                comment=data["comment"],
                actor=cast(User, request.user),
            )
            return Response(PaymentSerializer(payment).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)
