"""Эндпоинты контрагентов `[ТЗ 3.3]`.

`/clients`, `/clients/{id}`, `/vendors`, `/vendors/{id}`, `/contracts` —
пути и формы ответа по `openapi.yaml`.

Удаления контрагента нет намеренно: по клиенту есть счета, по поставщику —
заявки, и исчезнуть из истории они не могут. Вывод из обращения — снятие
признака `is_active`.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.db.models import Prefetch, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema, extend_schema_view, inline_serializer
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Organization, User
from accounts.permissions import Permission, has_permission
from billing.api.serializers import (
    TariffRuleCreateSerializer,
    TariffRuleSerializer,
    TariffSimulateRequestSerializer,
    TariffSimulateResultSerializer,
)
from billing.models import TariffRule
from billing.services import margin as margin_service
from billing.services import tariffs as tariff_service
from catalog.models import Service
from core.api.idempotency import IdempotentCreateMixin
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import SocViewSetMixin
from core.money import Money
from counterparties import services
from counterparties.api.serializers import (
    ClientCreateSerializer,
    ClientSerializer,
    VendorCandidateSerializer,
    VendorContractCreateSerializer,
    VendorContractSerializer,
    VendorCreateSerializer,
    VendorRatingSerializer,
    VendorSerializer,
    VendorServiceMappingSerializer,
    VendorSuggestRequestSerializer,
    payment_terms_to_fields,
)
from counterparties.models import (
    Client,
    Contact,
    Vendor,
    VendorContract,
    VendorServiceMapping,
)
from counterparties.services import rating as rating_service
from counterparties.services import suggest as suggest_service


@extend_schema_view(
    list=extend_schema(summary="Реестр клиентов", tags=["counterparties"]),
    retrieve=extend_schema(
        summary="Карточка клиента",
        tags=["counterparties"],
        responses={200: ClientSerializer, 404: ErrorResponseSerializer},
    ),
    create=extend_schema(summary="Создание клиента", tags=["counterparties"]),
)
class ClientViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/clients`."""

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = Client.objects.prefetch_related(
        Prefetch("contacts", queryset=Contact.objects.order_by("-is_primary", "name"))
    )
    serializer_class = ClientSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.CLIENT_VIEW,
        "retrieve": Permission.CLIENT_VIEW,
        "create": Permission.CLIENT_EDIT,
        # Чтение и запись тарифа различаются методом, а действие одно:
        # право проверяется в самом действии.
        "tariffs": (Permission.TARIFF_VIEW, Permission.TARIFF_EDIT),
        "simulate": Permission.TARIFF_VIEW,
    }

    def get_queryset(self) -> QuerySet[Client]:
        queryset = super().get_queryset()
        # Неактивные показываются только по явному запросу: реестр нужен
        # для работы, а не как архив.
        if self.request.query_params.get("includeInactive") != "true":
            queryset = queryset.filter(is_active=True)
        search = self.request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        return queryset

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = ClientCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            limit = data.get("creditLimit")

            client = services.create_client(
                organization=_organization_of(request.user),  # type: ignore[arg-type]
                name=data["name"],
                legal_name=data["legalName"],
                country=data["country"].upper(),
                settlement_currency=data["settlementCurrency"],
                default_locale=data["defaultLocale"],
                credit_limit_amount=limit["amount"] if limit else None,
                credit_limit_currency=limit["currency"] if limit else "",
                contacts=_contacts_payload(data["contacts"]),
                actor=request.user,  # type: ignore[arg-type]
                **payment_terms_to_fields(data["paymentTerms"]),
            )
            return Response(
                ClientSerializer(client).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)


    @extend_schema(
        methods=["GET"],
        summary="Тарифные правила клиента",
        tags=["counterparties"],
        responses={
            200: inline_serializer(
                "TariffRuleList", fields={"data": TariffRuleSerializer(many=True)}
            ),
            404: ErrorResponseSerializer,
        },
    )
    @extend_schema(
        methods=["POST"],
        summary="Добавление тарифного правила",
        tags=["counterparties"],
        request=TariffRuleCreateSerializer,
        responses={201: TariffRuleSerializer, 400: ErrorResponseSerializer},
    )
    @action(detail=True, methods=["get", "post"])
    def tariffs(self, request: Request, pk: str | None = None) -> Response:
        """Тарифы клиента `[ТЗ 3.4.1]`: правила с областью, способом и периодом."""
        client = get_object_or_404(Client, pk=pk)

        if request.method == "GET":
            rules = TariffRule.objects.filter(client=client).select_related("service")
            return Response({"data": TariffRuleSerializer(rules, many=True).data})

        role = str(getattr(request.user, "role", ""))
        if not has_permission(role, Permission.TARIFF_EDIT):
            raise PermissionDenied

        def produce() -> Response:
            payload = TariffRuleCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            scope = data["scope"]
            pricing = data["pricing"]
            discount = data.get("discount") or {}
            price = pricing.get("price")
            rule = tariff_service.create_rule(
                client=client,
                service=Service.objects.filter(pk=scope.get("serviceId")).first()
                if scope.get("serviceId")
                else None,
                category=scope.get("category") or "",
                airport_icao=scope.get("airportIcao") or "",
                mode=pricing["mode"],
                markup_percent=pricing.get("markupPercent"),
                fixed_price=Money.of(price["amount"], price["currency"]) if price else None,
                discount_kind=discount.get("kind", ""),
                discount_value=discount.get("value"),
                valid_from=data["validFrom"],
                valid_to=data["validTo"],
                actor=cast(User, request.user),
            )
            # Цены продажи в заявках без снимка и маржа рейсов клиента
            # считаются по тарифам — прежний расчёт больше не верен.
            margin_service.client_tariffs_changed(client.pk)
            return Response(TariffRuleSerializer(rule).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Песочница тарифа",
        tags=["counterparties"],
        request=TariffSimulateRequestSerializer,
        responses={200: TariffSimulateResultSerializer, 404: ErrorResponseSerializer},
    )
    @action(detail=True, methods=["post"], url_path="tariffs/simulate")
    def simulate(self, request: Request, pk: str | None = None) -> Response:
        """Какое правило сработало и почему `[ТЗ 3.4.1]` (`SPEC.md § 7.1`).

        Чтение через POST: ключ идемпотентности не нужен (ADR-018).
        """
        client = get_object_or_404(Client, pk=pk)
        payload = TariffSimulateRequestSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        unit = data.get("purchasePrice")
        result = tariff_service.simulate(
            client=client,
            service=Service.objects.get(pk=data["serviceId"]),
            airport_icao=data["airportIcao"],
            moment=data["onDate"],
            quantity=data["quantity"],
            purchase_unit_price=Money.of(unit["amount"], unit["currency"]) if unit else None,
        )
        return Response(
            {
                "salePrice": result.amount.to_json(),
                "appliedRuleId": result.rule.pk if result.rule else None,
                "explanation": result.steps,
                "candidateRules": result.candidates,
            }
        )


def _organization_of(user: User) -> Organization:
    """Организация пользователя, заводящего контрагента.

    Контрагент принадлежит арендатору (ADR-003), и без организации его
    некуда положить. Пользователь без организации — ошибка заведения
    учётной записи, и сказать об этом нужно прямо, а не создать запись
    в никуда.
    """
    organization = user.organization
    if organization is None:
        raise ValidationError(
            {"detail": "У вашей учётной записи не задана организация. Обратитесь к администратору."}
        )
    return organization


def _contacts_payload(contacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Сериализатор отдаёт поля модели (`is_primary`), сервис ждёт форму контракта."""
    return [
        {
            "name": contact["name"],
            "role": contact.get("role", ""),
            "email": contact["email"],
            "phone": contact.get("phone") or "",
            "locale": contact.get("locale", "ru"),
            "isPrimary": contact.get("is_primary", False),
        }
        for contact in contacts
    ]


@extend_schema_view(
    list=extend_schema(summary="Реестр поставщиков", tags=["counterparties"]),
    retrieve=extend_schema(
        summary="Карточка поставщика",
        tags=["counterparties"],
        responses={200: VendorSerializer, 404: ErrorResponseSerializer},
    ),
    create=extend_schema(summary="Создание поставщика", tags=["counterparties"]),
    partial_update=extend_schema(summary="Изменение поставщика", tags=["counterparties"]),
)
class VendorViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/vendors`."""

    http_method_names = ["get", "post", "patch", "head", "options"]  # noqa: RUF012
    queryset = Vendor.objects.prefetch_related("contacts", "certificates")
    serializer_class = VendorSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.VENDOR_VIEW,
        "retrieve": Permission.VENDOR_VIEW,
        "create": Permission.VENDOR_EDIT,
        "partial_update": Permission.VENDOR_EDIT,
        "rating": Permission.VENDOR_VIEW,
        # Подбор — расчёт без записи: им пользуется и тот, кто выбирает
        # поставщика, и тот, кто смотрит реестр.
        "suggest": (Permission.VENDOR_ASSIGN, Permission.VENDOR_VIEW),
    }

    def get_queryset(self) -> QuerySet[Vendor]:
        queryset = super().get_queryset()
        params = self.request.query_params
        if params.get("includeInactive") != "true":
            queryset = queryset.filter(is_active=True)
        if params.get("search"):
            queryset = queryset.filter(name__icontains=params["search"].strip())
        if params.get("category"):
            queryset = queryset.filter(specializations__contains=[params["category"]])
        if params.get("airportIcao"):
            queryset = queryset.filter(
                coverage_airports__contains=[params["airportIcao"].upper()]
            )
        return queryset

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = VendorCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            coverage = data.get("coverage") or {"airports": [], "regions": []}

            vendor = services.create_vendor(
                organization=_organization_of(request.user),  # type: ignore[arg-type]
                name=data["name"],
                legal_name=data["legalName"],
                country=data["country"].upper(),
                settlement_currency=data["settlementCurrency"],
                specializations=data["specializations"],
                coverage_airports=coverage.get("airports", []),
                coverage_regions=coverage.get("regions", []),
                manual_quality_score=data["manualQualityScore"],
                exchange_method=data["exchangeMethod"],
                contacts=_contacts_payload(data["contacts"]),
                certificates=_certificates_payload(data["certificates"]),
                actor=request.user,  # type: ignore[arg-type]
                **payment_terms_to_fields(data["paymentTerms"]),
            )
            return Response(VendorSerializer(vendor).data, status=status.HTTP_201_CREATED)

        return self.idempotent(request, produce)

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        vendor = self.get_object()
        payload = VendorCreateSerializer(data=request.data, partial=True)
        payload.fields["name"].validators = []
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        changes: dict[str, Any] = {}
        for source, field in (
            ("name", "name"),
            ("legalName", "legal_name"),
            ("country", "country"),
            ("settlementCurrency", "settlement_currency"),
            ("specializations", "specializations"),
            ("manualQualityScore", "manual_quality_score"),
            ("exchangeMethod", "exchange_method"),
        ):
            if source in data:
                changes[field] = data[source]
        if "coverage" in data:
            changes["coverage_airports"] = [
                code.upper() for code in data["coverage"].get("airports", [])
            ]
            changes["coverage_regions"] = data["coverage"].get("regions", [])
        if "paymentTerms" in data:
            changes.update(payment_terms_to_fields(data["paymentTerms"]))
        if "contacts" in data:
            changes["contacts"] = _contacts_payload(data["contacts"])
        if "certificates" in data:
            changes["certificates"] = _certificates_payload(data["certificates"])

        updated = services.update_vendor(
            vendor=vendor,
            changes=changes,
            actor=request.user,  # type: ignore[arg-type]
        )
        return Response(VendorSerializer(updated).data)


    @extend_schema(
        summary="Рейтинг поставщика с разложением на составляющие",
        tags=["counterparties"],
        responses={200: VendorRatingSerializer, 404: ErrorResponseSerializer},
    )
    @action(detail=True, methods=["get"])
    def rating(self, request: Request, pk: str | None = None) -> Response:
        """Рейтинг вычисляется, а не вводится `[ТЗ 3.3.1]` (`DOMAIN.md § 7.4`).

        Неактивный поставщик тоже имеет историю: карточку выведенного
        из обращения открывают, чтобы понять, почему его вывели.
        """
        vendor = get_object_or_404(Vendor, pk=pk)
        return Response(rating_service.to_contract(rating_service.rating_for(vendor)))

    @extend_schema(
        summary="Подбор поставщика",
        tags=["counterparties"],
        request=VendorSuggestRequestSerializer,
        responses={
            200: inline_serializer(
                "VendorCandidateList", fields={"data": VendorCandidateSerializer(many=True)}
            ),
            400: ErrorResponseSerializer,
        },
    )
    @action(detail=False, methods=["post"])
    def suggest(self, request: Request) -> Response:
        """Кандидаты с баллами и влиянием на маржу `[ТЗ 3.3.2]` (`DOMAIN.md § 7.5`).

        Чтение через POST: ключ идемпотентности не нужен (ADR-018), расчёт
        ничего не записывает.
        """
        from flights.models import Flight

        payload = VendorSuggestRequestSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        service = Service.objects.filter(pk=data["serviceId"], is_active=True).first()
        if service is None:
            raise ValidationError({"serviceId": "Услуга не найдена в каталоге"})
        flight = None
        if data.get("flightId"):
            flight = Flight.objects.filter(pk=data["flightId"]).first()
            if flight is None:
                raise ValidationError({"flightId": "Рейс не найден"})

        candidates = suggest_service.suggest(
            service=service,
            airport_icao=data["airportIcao"],
            moment=data["onDate"],
            quantity=data["quantity"],
            mode=data["mode"],
            custom_weights=data.get("weights"),
            flight=flight,
        )
        return Response(
            {"data": [suggest_service.to_contract(candidate) for candidate in candidates]}
        )


def _certificates_payload(certificates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "kind": certificate["kind"],
            "number": certificate["number"],
            "validFrom": certificate["valid_from"],
            "validTo": certificate["valid_to"],
        }
        for certificate in certificates
    ]


@extend_schema_view(
    list=extend_schema(summary="Договоры с поставщиками", tags=["counterparties"]),
    create=extend_schema(summary="Создание договора", tags=["counterparties"]),
)
class VendorContractViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/contracts` `[ТЗ 3.3.3]`.

    Фильтр по статусу применяется в Python, а не в SQL: статус вычисляется
    от дат и текущего момента (G-42), выражения для него в базе нет.
    Договоров у экспедитора сотни, а не миллионы, — цена приемлема.
    """

    http_method_names = ["get", "post", "head", "options"]  # noqa: RUF012
    queryset = VendorContract.objects.select_related("vendor").prefetch_related("attachments")
    serializer_class = VendorContractSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.CONTRACT_VIEW,
        "create": Permission.CONTRACT_EDIT,
    }

    def get_queryset(self) -> QuerySet[VendorContract]:
        queryset = super().get_queryset()
        vendor_id = self.request.query_params.get("vendorId")
        if vendor_id:
            queryset = queryset.filter(vendor_id=vendor_id)
        return queryset

    def filter_queryset(self, queryset: QuerySet[VendorContract]) -> Any:
        wanted = self.request.query_params.get("status")
        if not wanted:
            return queryset
        return [contract for contract in queryset if contract.status == wanted]

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        def produce() -> Response:
            payload = VendorContractCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            contract = services.create_contract(
                vendor=Vendor.objects.get(pk=data["vendorId"]),
                number=data["number"],
                valid_from=data["validFrom"],
                valid_to=data["validTo"],
                currency=data["currency"],
                attachment_ids=data["attachmentIds"],
                actor=request.user,  # type: ignore[arg-type]
                **payment_terms_to_fields(data["paymentTerms"]),
            )
            return Response(
                VendorContractSerializer(contract).data, status=status.HTTP_201_CREATED
            )

        return self.idempotent(request, produce)


@extend_schema_view(
    list=extend_schema(
        summary="Сопоставление номенклатуры поставщика с каталогом", tags=["counterparties"]
    ),
    create=extend_schema(
        summary="Добавление соответствия",
        request=VendorServiceMappingSerializer,
        responses={201: VendorServiceMappingSerializer, 400: ErrorResponseSerializer},
        tags=["counterparties"],
    ),
)
class VendorServiceMappingViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/vendor-service-mappings` (ADR-024) `[ТЗ 3.4.2]`.

    Справочник заполняется решениями оператора при разборе счёта:
    это не распознавание по наименованию, а запомненное решение —
    предсказуемо и объяснимо.
    """

    queryset = VendorServiceMapping.objects.select_related("vendor", "service")
    serializer_class = VendorServiceMappingSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.BILLING_RECONCILIATION,
        "create": Permission.BILLING_RECONCILIATION,
    }

    def get_queryset(self) -> QuerySet[VendorServiceMapping]:
        queryset: QuerySet[VendorServiceMapping] = super().get_queryset()
        vendor_id = self.request.query_params.get("vendorId")
        if vendor_id:
            queryset = queryset.filter(vendor_id=vendor_id)
        return queryset

    def perform_create(self, serializer: Any) -> None:
        from audit import services as audit
        from audit.models import AuditEntityType

        mapping = serializer.save()
        audit.record(
            entity_type=AuditEntityType.VENDOR,
            entity_id=mapping.vendor_id,
            action="service_mapping_added",
            actor=cast(User, self.request.user),
            after=audit.snapshot(mapping),
        )
