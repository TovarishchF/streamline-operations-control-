"""Сериализаторы заявок на услуги. Форма ответа — по `openapi.yaml`."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from catalog.api.serializers import ServiceSerializer
from catalog.models import Service
from core.api.attachments import AttachmentRefSerializer
from counterparties.models import Vendor
from flights.models import ServiceLeg
from orders.models import ServiceOrder
from orders.services import transitions


class ServiceOrderSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`ServiceOrder` из контракта.

    Денежные величины отдаются объектами `Money` со строковой суммой:
    число с плавающей точкой в деньгах запрещено на всех уровнях,
    включая JSON (`CLAUDE.md § 3` п. 1).
    """

    flightId = serializers.CharField(source="flight_id")  # noqa: N815
    serviceId = serializers.CharField(source="service_id")  # noqa: N815
    service = ServiceSerializer(read_only=True)
    airportIcao = serializers.CharField(source="airport_icao")  # noqa: N815
    vendorId = serializers.CharField(source="vendor_id", allow_null=True)  # noqa: N815
    vendorName = serializers.CharField(source="vendor.name", allow_null=True, default=None)  # noqa: N815
    contractId = serializers.CharField(source="contract_id", allow_null=True)  # noqa: N815

    availableTransitions = serializers.SerializerMethodField()  # noqa: N815

    quantity = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=True)
    actualQuantity = serializers.DecimalField(  # noqa: N815
        source="actual_quantity",
        max_digits=18,
        decimal_places=4,
        coerce_to_string=True,
        allow_null=True,
    )

    purchasePrice = serializers.SerializerMethodField()  # noqa: N815
    actualPurchaseUnitPrice = serializers.SerializerMethodField()  # noqa: N815
    purchaseSurcharges = serializers.JSONField(source="purchase_surcharges")  # noqa: N815
    purchaseCost = serializers.SerializerMethodField()  # noqa: N815
    salePrice = serializers.SerializerMethodField()  # noqa: N815
    tariffRuleId = serializers.SerializerMethodField()  # noqa: N815
    contractTermsSnapshot = serializers.JSONField(source="contract_terms_snapshot")  # noqa: N815

    orderedAt = serializers.DateTimeField(source="ordered_at", allow_null=True)  # noqa: N815
    confirmedAt = serializers.DateTimeField(source="confirmed_at", allow_null=True)  # noqa: N815
    startedAt = serializers.DateTimeField(source="started_at", allow_null=True)  # noqa: N815
    completedAt = serializers.DateTimeField(source="completed_at", allow_null=True)  # noqa: N815
    actualStartAt = serializers.DateTimeField(source="actual_start_at", allow_null=True)  # noqa: N815
    actualEndAt = serializers.DateTimeField(source="actual_end_at", allow_null=True)  # noqa: N815

    slaConfirmDeadline = serializers.DateTimeField(  # noqa: N815
        source="sla_confirm_deadline", allow_null=True
    )
    slaBreached = serializers.BooleanField(source="sla_breached")  # noqa: N815
    rejectionReason = serializers.CharField(source="rejection_reason", allow_null=True)  # noqa: N815
    replacedOrderId = serializers.CharField(source="replaced_order_id", allow_null=True)  # noqa: N815

    documents = serializers.SerializerMethodField()
    dataSource = serializers.CharField(source="data_source")  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo")  # noqa: N815

    class Meta:
        model = ServiceOrder
        fields = (
            "id", "flightId", "serviceId", "service", "leg", "airportIcao",
            "vendorId", "vendorName", "contractId", "status", "availableTransitions",
            "quantity", "actualQuantity", "attributes",
            "purchasePrice", "actualPurchaseUnitPrice", "purchaseSurcharges",
            "purchaseCost", "salePrice", "tariffRuleId", "contractTermsSnapshot",
            "orderedAt", "confirmedAt", "startedAt", "completedAt",
            "actualStartAt", "actualEndAt",
            "slaConfirmDeadline", "slaBreached", "rejectionReason", "replacedOrderId",
            "documents", "dataSource", "isDemo",
        )

    def get_availableTransitions(self, obj: ServiceOrder) -> list[str]:  # noqa: N802
        return transitions.available_transitions(obj)

    def _money(self, amount: Decimal | None, currency: str) -> dict[str, str] | None:
        if amount is None or not currency:
            return None
        return {"amount": str(amount), "currency": currency}

    def get_purchasePrice(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        return self._money(obj.purchase_unit_amount, obj.purchase_currency)

    def get_actualPurchaseUnitPrice(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        return self._money(obj.actual_purchase_unit_amount, obj.purchase_currency)

    def get_purchaseCost(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        return self._money(obj.purchase_cost_amount, obj.purchase_currency)

    def get_salePrice(self, obj: ServiceOrder) -> dict[str, str] | None:  # noqa: N802
        """Цена продажи считается по тарифам клиента (`DOMAIN.md § 7.2`).

        Тарифные правила — задача вехи M7. До неё поле пусто, а не равно
        закупочной цене: выдать закупку за продажу значило бы показать
        нулевую маржу как настоящую (`CLAUDE.md § 4`).
        """
        return None

    def get_tariffRuleId(self, obj: ServiceOrder) -> str | None:  # noqa: N802
        return None

    def get_documents(self, obj: ServiceOrder) -> list[dict[str, Any]]:
        """Только завершённые загрузки: ссылка в никуда в карточке не нужна."""
        uploaded = [doc for doc in obj.documents.all() if doc.uploaded_at is not None]
        return list(AttachmentRefSerializer(uploaded, many=True).data)


class ServiceOrderCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ServiceOrderCreate` из контракта."""

    serviceId = serializers.CharField()  # noqa: N815
    leg = serializers.ChoiceField(choices=ServiceLeg.choices)
    quantity = serializers.DecimalField(
        max_digits=18, decimal_places=4, min_value=Decimal("0.0001")
    )
    vendorId = serializers.CharField(required=False, allow_null=True, allow_blank=True)  # noqa: N815
    attributes = serializers.DictField(required=False, default=dict)
    overrideReason = serializers.CharField(  # noqa: N815
        required=False, allow_blank=True, default=""
    )

    def validate_serviceId(self, value: str) -> str:  # noqa: N802
        if not Service.objects.filter(pk=value, is_active=True).exists():
            raise serializers.ValidationError("Услуга не найдена в каталоге")
        return value

    def validate_vendorId(self, value: str | None) -> str | None:  # noqa: N802
        if not value:
            return None
        if not Vendor.objects.filter(pk=value, is_active=True).exists():
            raise serializers.ValidationError("Поставщик не найден")
        return value


class ServiceOrderUpdateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ServiceOrderUpdate` из контракта."""

    vendorId = serializers.CharField(required=False)  # noqa: N815
    quantity = serializers.DecimalField(
        max_digits=18, decimal_places=4, min_value=Decimal("0.0001"), required=False
    )
    actualQuantity = serializers.DecimalField(  # noqa: N815
        max_digits=18, decimal_places=4, min_value=Decimal(0), required=False
    )
    actualStartAt = serializers.DateTimeField(required=False)  # noqa: N815
    actualEndAt = serializers.DateTimeField(required=False)  # noqa: N815
    attributes = serializers.DictField(required=False)
    documentStorageKey = serializers.CharField(required=False)  # noqa: N815

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        start = attrs.get("actualStartAt")
        end = attrs.get("actualEndAt")
        if start and end and end < start:
            raise serializers.ValidationError(
                {"actualEndAt": "Фактическое окончание раньше начала"}
            )
        return attrs


class ServiceOrderTransitionSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ServiceOrderTransitionRequest` из контракта.

    Фактические время и количество принимаются вместе с переходом `finish`:
    иначе поставщику пришлось бы сперва сохранить карточку, потом нажать
    «Выполнена», и между этими действиями заявка была бы в невозможном
    состоянии.
    """

    transition = serializers.ChoiceField(
        choices=["order", "confirm", "reject", "begin", "finish", "cancel"]
    )
    reasonCode = serializers.CharField(required=False, allow_blank=True, default="")  # noqa: N815
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    actualStartAt = serializers.DateTimeField(required=False)  # noqa: N815
    actualEndAt = serializers.DateTimeField(required=False)  # noqa: N815
    actualQuantity = serializers.DecimalField(  # noqa: N815
        max_digits=18, decimal_places=4, min_value=Decimal(0), required=False
    )


class ServiceOrderReassignSerializer(serializers.Serializer):  # type: ignore[type-arg]
    vendorId = serializers.CharField()  # noqa: N815
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_vendorId(self, value: str) -> str:  # noqa: N802
        if not Vendor.objects.filter(pk=value, is_active=True).exists():
            raise serializers.ValidationError("Поставщик не найден")
        return value


class ServiceCheckResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Результат проверки `SPEC.md § 5.2` для предварительного показа."""

    code = serializers.CharField()
    passed = serializers.BooleanField()
    blocking = serializers.BooleanField()
    message = serializers.CharField()
