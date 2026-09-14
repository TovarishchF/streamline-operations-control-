"""Сериализаторы контрагентов. Форма — по `openapi.yaml`.

Условия расчётов в контракте — вложенный объект `paymentTerms`, в базе —
три колонки (`counterparties.models.PaymentTermsMixin`). Переходник между
ними здесь: контракт согласован с клиентами до кода и под форму хранения
не подстраивается (`CLAUDE.md § 3` п. 6).
"""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from core.api.attachments import AttachmentRefSerializer
from core.money import SUPPORTED_CURRENCIES
from counterparties.models import (
    CertificateKind,
    Client,
    Contact,
    PaymentMode,
    Vendor,
    VendorCertificate,
    VendorContract,
)


class CurrencyField(serializers.CharField):
    """Код валюты из перечня поддерживаемых `[ТЗ 3.4.1]`."""

    def to_internal_value(self, data: Any) -> str:
        code = str(super().to_internal_value(data)).upper()
        if code not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError(
                f"Валюта {code} не поддерживается. Допустимы: "
                f"{', '.join(sorted(SUPPORTED_CURRENCIES))}"
            )
        return code


class MoneySerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`Money` из контракта: сумма строкой, 4 знака (`CLAUDE.md § 3` п. 1)."""

    amount = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=True)
    currency = CurrencyField(max_length=3)


class PaymentTermsSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`PaymentTerms` из контракта."""

    mode = serializers.ChoiceField(choices=PaymentMode.choices)
    deferDays = serializers.IntegerField(min_value=0, default=0)  # noqa: N815
    prepaymentPercent = serializers.DecimalField(  # noqa: N815
        max_digits=6, decimal_places=4, required=False, allow_null=True, coerce_to_string=True
    )

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Согласованность способа расчётов и его параметров.

        Отсрочка в ноль дней — это постоплата, названная другим словом;
        предоплата без доли непонятно чему равна. Оба случая — ошибка
        ввода, и поймать её нужно здесь, а не при выставлении счёта.
        """
        mode = attrs.get("mode")
        if mode == PaymentMode.DEFERRED and not attrs.get("deferDays"):
            raise serializers.ValidationError(
                {"deferDays": "У отсрочки обязан быть срок больше нуля дней"}
            )
        if mode == PaymentMode.PREPAYMENT and not attrs.get("prepaymentPercent"):
            raise serializers.ValidationError(
                {"prepaymentPercent": "У предоплаты обязана быть указана доля в процентах"}
            )
        if mode != PaymentMode.DEFERRED:
            attrs["deferDays"] = 0
        return attrs


def payment_terms_of(instance: Any) -> dict[str, Any]:
    """Три колонки модели в объект контракта."""
    percent = instance.payment_prepayment_percent
    terms: dict[str, Any] = {
        "mode": instance.payment_mode,
        "deferDays": instance.payment_defer_days,
    }
    if percent is not None:
        terms["prepaymentPercent"] = str(percent)
    return terms


def payment_terms_to_fields(terms: dict[str, Any]) -> dict[str, Any]:
    """Объект контракта в три колонки модели."""
    return {
        "payment_mode": terms["mode"],
        "payment_defer_days": terms.get("deferDays", 0),
        "payment_prepayment_percent": terms.get("prepaymentPercent"),
    }


class ContactSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    isPrimary = serializers.BooleanField(source="is_primary", default=False)  # noqa: N815
    phone = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    role = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Contact
        fields = ("name", "role", "email", "phone", "locale", "isPrimary")


class VendorCertificateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    validFrom = serializers.DateTimeField(source="valid_from")  # noqa: N815
    validTo = serializers.DateTimeField(source="valid_to")  # noqa: N815
    kind = serializers.ChoiceField(choices=CertificateKind.choices)

    class Meta:
        model = VendorCertificate
        fields = ("kind", "number", "validFrom", "validTo")


# ─────────────────────────── Клиент ───────────────────────────


class ClientSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    legalName = serializers.CharField(source="legal_name")  # noqa: N815
    settlementCurrency = serializers.CharField(source="settlement_currency")  # noqa: N815
    defaultLocale = serializers.CharField(source="default_locale")  # noqa: N815
    isActive = serializers.BooleanField(source="is_active")  # noqa: N815
    paymentTerms = serializers.SerializerMethodField()  # noqa: N815
    creditLimit = serializers.SerializerMethodField()  # noqa: N815
    contacts = ContactSerializer(many=True, read_only=True)
    dataSource = serializers.CharField(source="data_source", read_only=True)  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo", read_only=True)  # noqa: N815

    class Meta:
        model = Client
        fields = (
            "id", "name", "legalName", "country", "settlementCurrency",
            "paymentTerms", "contacts", "defaultLocale", "creditLimit",
            "isActive", "dataSource", "isDemo",
        )

    def get_paymentTerms(self, obj: Client) -> dict[str, Any]:  # noqa: N802
        return payment_terms_of(obj)

    def get_creditLimit(self, obj: Client) -> dict[str, str] | None:  # noqa: N802
        if obj.credit_limit_amount is None:
            return None
        return {"amount": str(obj.credit_limit_amount), "currency": obj.credit_limit_currency}


class ClientCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ClientCreate` из контракта."""

    name = serializers.CharField(max_length=255)
    legalName = serializers.CharField(max_length=500)  # noqa: N815
    country = serializers.CharField(max_length=2, required=False, allow_blank=True, default="")
    settlementCurrency = CurrencyField(max_length=3)  # noqa: N815
    paymentTerms = PaymentTermsSerializer()  # noqa: N815
    contacts = ContactSerializer(many=True, required=False, default=list)
    defaultLocale = serializers.ChoiceField(  # noqa: N815
        choices=[("ru", "ru"), ("en", "en")], default="ru"
    )
    creditLimit = MoneySerializer(required=False, allow_null=True)  # noqa: N815

    def validate_name(self, value: str) -> str:
        """Тёзки среди клиентов — источник ошибочно выставленных счетов."""
        name = value.strip()
        if Client.objects.filter(name__iexact=name).exists():
            raise serializers.ValidationError(f"Клиент с наименованием «{name}» уже заведён")
        return name

    def validate_contacts(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return _validate_single_primary(value)


def _validate_single_primary(contacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Основной контакт ровно один: на него уходит переписка."""
    primary = [c for c in contacts if c.get("is_primary")]
    if len(primary) > 1:
        raise serializers.ValidationError("Основным можно отметить только один контакт")
    if contacts and not primary:
        contacts[0]["is_primary"] = True
    return contacts


# ─────────────────────────── Поставщик ───────────────────────────


class VendorSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    legalName = serializers.CharField(source="legal_name")  # noqa: N815
    settlementCurrency = serializers.CharField(source="settlement_currency")  # noqa: N815
    isActive = serializers.BooleanField(source="is_active")  # noqa: N815
    paymentTerms = serializers.SerializerMethodField()  # noqa: N815
    coverage = serializers.SerializerMethodField()
    contacts = ContactSerializer(many=True, read_only=True)
    certificates = VendorCertificateSerializer(many=True, read_only=True)
    manualQualityScore = serializers.IntegerField(source="manual_quality_score")  # noqa: N815
    exchangeMethod = serializers.CharField(source="exchange_method")  # noqa: N815
    dataSource = serializers.CharField(source="data_source", read_only=True)  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo", read_only=True)  # noqa: N815

    class Meta:
        model = Vendor
        fields = (
            "id", "name", "legalName", "country", "settlementCurrency",
            "specializations", "coverage", "paymentTerms", "contacts",
            "certificates", "exchangeMethod", "manualQualityScore",
            "isActive", "dataSource", "isDemo",
        )

    def get_paymentTerms(self, obj: Vendor) -> dict[str, Any]:  # noqa: N802
        return payment_terms_of(obj)

    def get_coverage(self, obj: Vendor) -> dict[str, list[str]]:
        return {"airports": obj.coverage_airports, "regions": obj.coverage_regions}


class CoverageSerializer(serializers.Serializer):  # type: ignore[type-arg]
    airports = serializers.ListField(
        child=serializers.CharField(min_length=4, max_length=4), required=False, default=list
    )
    regions = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class VendorCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`VendorCreate` из контракта."""

    name = serializers.CharField(max_length=255)
    legalName = serializers.CharField(max_length=500)  # noqa: N815
    country = serializers.CharField(max_length=2, required=False, allow_blank=True, default="")
    settlementCurrency = CurrencyField(max_length=3)  # noqa: N815
    specializations = serializers.ListField(child=serializers.CharField(), default=list)
    coverage = CoverageSerializer(required=False)
    paymentTerms = PaymentTermsSerializer()  # noqa: N815
    contacts = ContactSerializer(many=True, required=False, default=list)
    certificates = VendorCertificateSerializer(many=True, required=False, default=list)
    manualQualityScore = serializers.IntegerField(  # noqa: N815
        min_value=0, max_value=5, default=3
    )
    exchangeMethod = serializers.ChoiceField(  # noqa: N815
        choices=["portal", "email", "api"], default="email"
    )

    def validate_name(self, value: str) -> str:
        name = value.strip()
        if Vendor.objects.filter(name__iexact=name).exists():
            raise serializers.ValidationError(f"Поставщик с наименованием «{name}» уже заведён")
        return name

    def validate_contacts(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return _validate_single_primary(value)


# ─────────────────────────── Договор ───────────────────────────


class VendorContractSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    vendorId = serializers.CharField(source="vendor_id")  # noqa: N815
    validFrom = serializers.DateTimeField(source="valid_from")  # noqa: N815
    validTo = serializers.DateTimeField(source="valid_to")  # noqa: N815
    terminatedAt = serializers.DateTimeField(source="terminated_at", allow_null=True)  # noqa: N815
    paymentTerms = serializers.SerializerMethodField()  # noqa: N815
    # Статус вычисляется от дат, а не хранится (G-42): хранимый неизбежно
    # разъезжается с датами, потому что его некому пересчитывать в полночь.
    status = serializers.CharField(read_only=True)
    attachments = serializers.SerializerMethodField()

    class Meta:
        model = VendorContract
        fields = (
            "id", "vendorId", "number", "validFrom", "validTo", "terminatedAt",
            "currency", "paymentTerms", "status", "attachments",
        )

    def get_paymentTerms(self, obj: VendorContract) -> dict[str, Any]:  # noqa: N802
        return payment_terms_of(obj)

    def get_attachments(self, obj: VendorContract) -> list[dict[str, Any]]:
        """Только завершённые загрузки: ссылка в никуда в договоре недопустима."""
        uploaded = [a for a in obj.attachments.all() if a.uploaded_at is not None]
        return list(AttachmentRefSerializer(uploaded, many=True).data)


class VendorContractCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`VendorContractCreate` из контракта."""

    vendorId = serializers.CharField()  # noqa: N815
    number = serializers.CharField(max_length=64)
    validFrom = serializers.DateTimeField()  # noqa: N815
    validTo = serializers.DateTimeField()  # noqa: N815
    currency = CurrencyField(max_length=3)
    paymentTerms = PaymentTermsSerializer()  # noqa: N815
    attachmentIds = serializers.ListField(  # noqa: N815
        child=serializers.CharField(), required=False, default=list
    )

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["validTo"] <= attrs["validFrom"]:
            raise serializers.ValidationError(
                {"validTo": "Дата окончания договора обязана быть позже даты начала"}
            )
        if not Vendor.objects.filter(pk=attrs["vendorId"], is_active=True).exists():
            raise serializers.ValidationError({"vendorId": "Поставщик не найден"})
        if VendorContract.objects.filter(
            vendor_id=attrs["vendorId"], number=attrs["number"]
        ).exists():
            raise serializers.ValidationError(
                {"number": f"У этого поставщика уже есть договор № {attrs['number']}"}
            )
        return attrs
