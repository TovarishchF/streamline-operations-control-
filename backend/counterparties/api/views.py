"""Эндпоинты контрагентов `[ТЗ 3.3]`.

На этой вехе — только чтение реестра клиентов: без него нельзя создать рейс,
а создание рейса — задача M4. Ведение карточки клиента, тарифы, контракты
и рейтинг поставщиков — M6.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import serializers

from accounts.permissions import Permission
from core.api.viewsets import ReferenceViewSet
from counterparties.models import Client, Vendor


class ClientSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    legalName = serializers.CharField(source="legal_name")  # noqa: N815
    settlementCurrency = serializers.CharField(source="settlement_currency")  # noqa: N815
    defaultLocale = serializers.CharField(source="default_locale")  # noqa: N815
    isActive = serializers.BooleanField(source="is_active")  # noqa: N815

    class Meta:
        model = Client
        fields = (
            "id", "name", "legalName", "country", "settlementCurrency",
            "defaultLocale", "isActive",
        )


class VendorSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    legalName = serializers.CharField(source="legal_name")  # noqa: N815
    settlementCurrency = serializers.CharField(source="settlement_currency")  # noqa: N815
    isActive = serializers.BooleanField(source="is_active")  # noqa: N815

    class Meta:
        model = Vendor
        fields = (
            "id", "name", "legalName", "country", "settlementCurrency",
            "specializations", "isActive",
        )


@extend_schema_view(list=extend_schema(summary="Реестр клиентов", tags=["counterparties"]))
class ClientViewSet(ReferenceViewSet):
    """`GET /api/v1/clients`."""

    queryset = Client.objects.filter(is_active=True)
    serializer_class = ClientSerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.CLIENT_VIEW}

    def get_queryset(self) -> QuerySet[Client]:
        queryset = super().get_queryset()
        search = self.request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        return queryset


@extend_schema_view(list=extend_schema(summary="Реестр поставщиков", tags=["counterparties"]))
class VendorViewSet(ReferenceViewSet):
    """`GET /api/v1/vendors`."""

    queryset = Vendor.objects.filter(is_active=True)
    serializer_class = VendorSerializer
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.VENDOR_VIEW}

    def get_queryset(self) -> QuerySet[Vendor]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("search"):
            queryset = queryset.filter(name__icontains=params["search"].strip())
        if params.get("category"):
            queryset = queryset.filter(specializations__contains=[params["category"]])
        return queryset
