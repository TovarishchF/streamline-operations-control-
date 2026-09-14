"""Сериализаторы документов биллинга. Форма ответа — по `openapi.yaml`."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from billing.models import DocumentLine, Invoice, Quote


class DocumentLineSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`DocumentLine` из контракта.

    Суммы отдаются объектами `Money` со строковым значением: число
    с плавающей точкой в деньгах запрещено на всех уровнях, включая
    JSON (`CLAUDE.md § 3` п. 1).
    """

    serviceOrderId = serializers.CharField(source="service_order_id", allow_null=True)  # noqa: N815
    airportIcao = serializers.CharField(source="airport_icao")  # noqa: N815
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=True)
    unitPrice = serializers.SerializerMethodField()  # noqa: N815
    amount = serializers.SerializerMethodField()
    vatRateId = serializers.CharField(source="vat_rate_id", allow_null=True)  # noqa: N815
    vatAmount = serializers.SerializerMethodField()  # noqa: N815
    tariffRuleId = serializers.CharField(source="tariff_rule_id", allow_null=True)  # noqa: N815

    class Meta:
        model = DocumentLine
        fields = (
            "serviceOrderId", "description", "airportIcao", "quantity",
            "unitPrice", "amount", "vatRateId", "vatAmount", "tariffRuleId",
        )

    def get_unitPrice(self, obj: DocumentLine) -> dict[str, str]:  # noqa: N802
        return {"amount": str(obj.unit_price_amount), "currency": obj.currency}

    def get_amount(self, obj: DocumentLine) -> dict[str, str]:
        return {"amount": str(obj.amount), "currency": obj.currency}

    def get_vatAmount(self, obj: DocumentLine) -> dict[str, str]:  # noqa: N802
        return {"amount": str(obj.vat_amount), "currency": obj.currency}


def totals_of(document: Quote | Invoice) -> dict[str, dict[str, str]]:
    """`DocumentTotals` из контракта."""
    currency = document.currency
    return {
        "subtotal": {"amount": str(document.subtotal_amount), "currency": currency},
        "discountTotal": {"amount": str(document.discount_amount), "currency": currency},
        "feesTotal": {"amount": str(document.fees_amount), "currency": currency},
        "vatTotal": {"amount": str(document.vat_amount), "currency": currency},
        "grandTotal": {"amount": str(document.total_amount), "currency": currency},
    }


class QuoteSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    flightId = serializers.CharField(source="flight_id")  # noqa: N815
    clientId = serializers.CharField(source="client_id")  # noqa: N815
    number = serializers.SerializerMethodField()
    issuedAt = serializers.DateTimeField(source="issued_at", allow_null=True)  # noqa: N815
    validUntil = serializers.DateTimeField(source="valid_until", allow_null=True)  # noqa: N815
    fx = serializers.JSONField(source="fx_snapshot")
    lines = DocumentLineSerializer(many=True, read_only=True)
    totals = serializers.SerializerMethodField()
    voidedByDocId = serializers.CharField(source="voided_by_id", allow_null=True)  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo")  # noqa: N815

    class Meta:
        model = Quote
        fields = (
            "id", "number", "flightId", "clientId", "status", "issuedAt",
            "validUntil", "currency", "fx", "lines", "fees", "totals",
            "voidedByDocId", "isDemo",
        )

    def get_number(self, obj: Quote) -> str | None:
        """Номер присваивается при выставлении: у черновика его нет."""
        return obj.number or None

    def get_totals(self, obj: Quote) -> dict[str, dict[str, str]]:
        return totals_of(obj)


class InvoiceSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    flightId = serializers.CharField(source="flight_id")  # noqa: N815
    clientId = serializers.CharField(source="client_id")  # noqa: N815
    quoteId = serializers.CharField(source="quote_id", allow_null=True)  # noqa: N815
    number = serializers.SerializerMethodField()
    issuedAt = serializers.DateTimeField(source="issued_at", allow_null=True)  # noqa: N815
    dueDate = serializers.DateTimeField(source="due_date", allow_null=True)  # noqa: N815
    fx = serializers.JSONField(source="fx_snapshot")
    lines = DocumentLineSerializer(many=True, read_only=True)
    totals = serializers.SerializerMethodField()
    paidAmount = serializers.SerializerMethodField()  # noqa: N815
    planFactComparison = serializers.JSONField(source="plan_fact_comparison")  # noqa: N815
    voidedByDocId = serializers.CharField(source="voided_by_id", allow_null=True)  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo")  # noqa: N815

    class Meta:
        model = Invoice
        fields = (
            "id", "number", "flightId", "clientId", "quoteId", "status",
            "issuedAt", "dueDate", "currency", "fx", "lines", "fees", "totals",
            "paidAmount", "planFactComparison", "voidedByDocId", "isDemo",
        )

    def get_number(self, obj: Invoice) -> str | None:
        return obj.number or None

    def get_totals(self, obj: Invoice) -> dict[str, dict[str, str]]:
        return totals_of(obj)

    def get_paidAmount(self, obj: Invoice) -> dict[str, str]:  # noqa: N802
        """Оплаченная сумма считается из платежей (ADR-019).

        Платежи — следующий слой той же вехи; до него здесь ноль,
        а не выдуманная сумма. Статус счёта вычисляется из платежей,
        поэтому «оплачен» тоже пока не выставляется.
        """
        return {"amount": "0.0000", "currency": obj.currency}


class QuoteCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    flightId = serializers.CharField()  # noqa: N815
    validUntil = serializers.DateTimeField(required=False, allow_null=True)  # noqa: N815


class InvoiceCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    flightId = serializers.CharField()  # noqa: N815
    quoteId = serializers.CharField(required=False, allow_null=True, allow_blank=True)  # noqa: N815


class VoidSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Аннулирование требует причины: она идёт в аудит."""

    reason = serializers.CharField(allow_blank=False)


class TariffRuleSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`TariffRule` из контракта. Область — вложенный объект, в базе — колонки."""

    id = serializers.CharField(read_only=True)
    clientId = serializers.CharField(source="client_id", read_only=True)  # noqa: N815
    scope = serializers.SerializerMethodField()
    pricing = serializers.SerializerMethodField()
    discount = serializers.SerializerMethodField()
    validFrom = serializers.DateTimeField(source="valid_from")  # noqa: N815
    validTo = serializers.DateTimeField(source="valid_to")  # noqa: N815
    priority = serializers.IntegerField(read_only=True)

    def get_scope(self, obj: Any) -> dict[str, Any]:
        scope: dict[str, Any] = {}
        if obj.service_id:
            scope["serviceId"] = obj.service_id
        if obj.category:
            scope["category"] = obj.category
        if obj.airport_icao:
            scope["airportIcao"] = obj.airport_icao
        return scope

    def get_pricing(self, obj: Any) -> dict[str, Any]:
        if obj.mode == "cost_plus":
            return {"mode": obj.mode, "markupPercent": str(obj.markup_percent or Decimal(0))}
        if obj.mode == "fixed":
            return {
                "mode": obj.mode,
                "price": {
                    "amount": str(obj.fixed_amount or Decimal(0)),
                    "currency": obj.fixed_currency,
                },
            }
        return {"mode": obj.mode}

    def get_discount(self, obj: Any) -> dict[str, str] | None:
        if not obj.discount_kind:
            return None
        return {"kind": obj.discount_kind, "value": str(obj.discount_value or Decimal(0))}


class ExportRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ExportRequest` из контракта."""

    format = serializers.ChoiceField(choices=["pdf", "xlsx"])
    locale = serializers.ChoiceField(choices=["ru", "en"], required=False, default="ru")
    currency = serializers.CharField(required=False, allow_blank=True, default="")


class ExportTicketSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ExportTicket` из контракта.

    Форма ответа рассчитана на отложенную задачу, хотя формирование
    сейчас синхронное: перенос в очередь при росте объёмов не должен
    требовать менять клиентов.
    """

    taskId = serializers.CharField()  # noqa: N815
    status = serializers.ChoiceField(choices=["queued", "running", "ready", "failed"])
    downloadUrl = serializers.CharField(allow_null=True)  # noqa: N815
    expiresAt = serializers.DateTimeField(allow_null=True)  # noqa: N815
