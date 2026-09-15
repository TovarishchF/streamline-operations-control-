"""Эндпоинты отчётности `[ТЗ 3.6.1, 3.6.3]`.

`/reports`, `/reports/{code}`, `/reports/{code}/export`,
`/report-subscriptions` — пути и формы по `openapi.yaml`.

Права разделены по существу отчёта: операционные отчёты видит диспетчер,
финансовые — финансист и руководитель. Клиенту и поставщику отчёты
не показываются вовсе: у поставщика есть свои показатели в портале,
а сводка по всем поставщикам — не его дело.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import Permission
from audit import services as audit
from core import clock
from core.api.idempotency import IdempotencyMixin, IdempotentCreateMixin
from core.api.permissions import HasRolePermission
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import SocViewSetMixin
from reports import definitions
from reports.models import ReportSubscription
from reports.services import builders, export

# Отчёты, для которых нужно право на финансовые сведения. Остальные —
# операционные. Разделение по составу данных, а не по названию: в отчёте
# по поставщикам есть объём закупки, и это финансовая величина.
FINANCIAL_REPORTS = frozenset(
    {
        definitions.FINANCIAL,
        definitions.RECEIVABLES_PAYABLES,
        definitions.VENDORS,
    }
)


class ReportDefinitionSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ReportDefinition` из контракта."""

    code = serializers.CharField()
    name = serializers.DictField(child=serializers.CharField())
    parameters = serializers.ListField(child=serializers.DictField())


class ReportResultSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ReportResult` из контракта."""

    code = serializers.CharField()
    generatedAt = serializers.DateTimeField()  # noqa: N815
    currency = serializers.CharField()
    isDemo = serializers.BooleanField()  # noqa: N815
    columns = serializers.ListField(child=serializers.DictField())
    rows = serializers.ListField(child=serializers.DictField())
    totals = serializers.DictField()


class ReportExportSerializer(serializers.Serializer):  # type: ignore[type-arg]
    format = serializers.ChoiceField(choices=["pdf", "xlsx", "csv", "xml"])
    locale = serializers.ChoiceField(choices=["ru", "en"], required=False, default="ru")
    currency = serializers.CharField(required=False, allow_blank=True, default="")


class ExportTicketSerializer(serializers.Serializer):  # type: ignore[type-arg]
    taskId = serializers.CharField()  # noqa: N815
    status = serializers.ChoiceField(choices=["queued", "running", "ready", "failed"])
    downloadUrl = serializers.CharField(allow_null=True)  # noqa: N815
    expiresAt = serializers.DateTimeField(allow_null=True)  # noqa: N815


class ReportSubscriptionSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`ReportSubscription` из контракта."""

    timeUtc = serializers.CharField(source="time_utc", required=False)  # noqa: N815
    format = serializers.ChoiceField(
        source="export_format", choices=["pdf", "xlsx", "csv", "xml"]
    )
    recipients = serializers.ListField(child=serializers.EmailField(), min_length=1)
    parameters = serializers.DictField(required=False, default=dict)

    class Meta:
        model = ReportSubscription
        fields = ("id", "code", "schedule", "timeUtc", "format", "recipients", "parameters")

    def validate_code(self, value: str) -> str:
        if value not in definitions.DEFINITIONS:
            raise serializers.ValidationError("Неизвестный отчёт")
        return value

    def validate_timeUtc(self, value: str) -> str:  # noqa: N802
        """Время в виде ЧЧ:ММ. Подписка на «25:70» не сработает никогда."""
        import re

        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
            raise serializers.ValidationError("Ожидается время в виде ЧЧ:ММ по UTC")
        return value


def _required_permission(code: str) -> tuple[str, ...]:
    return (
        (Permission.REPORTS_FINANCIAL,)
        if code in FINANCIAL_REPORTS
        else (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL)
    )


def check_report_permission(request: Request, code: str) -> None:
    """Право на конкретный отчёт, а не на отчётность вообще.

    Проверка отдельная от `HasRolePermission`: каталог отчётов видят все,
    у кого есть право хотя бы на один, а конкретный отчёт — только те,
    кому положен именно он. Вызывается и при построении, и при выгрузке:
    запрет на просмотр, не распространённый на выгрузку, запретом не является.
    """
    from rest_framework.exceptions import PermissionDenied

    from accounts.permissions import has_permission

    role = str(getattr(request.user, "role", ""))
    if not any(has_permission(role, item) for item in _required_permission(code)):
        raise PermissionDenied


def _parse_params(request: Request, code: str) -> dict[str, Any]:
    """Параметры отчёта из строки запроса.

    Период по умолчанию — последние тридцать суток: отчёт, открытый
    без параметров, должен что-то показать, а не пустую таблицу
    с просьбой заполнить форму.
    """
    spec = definitions.definition(code)
    params: dict[str, Any] = {}
    today = clock.now().date()

    for parameter in spec.parameters:
        raw = request.query_params.get(parameter.key)
        if parameter.type == "date":
            if raw:
                try:
                    params[parameter.key] = date.fromisoformat(raw)
                except ValueError:
                    raise serializers.ValidationError(
                        {parameter.key: "Ожидается дата в виде ГГГГ-ММ-ДД"}
                    ) from None
            elif parameter.key == "from":
                params["from"] = today - timedelta(days=30)
            elif parameter.key == "to":
                params["to"] = today
            elif parameter.required:
                raise serializers.ValidationError({parameter.key: "Параметр обязателен"})
        elif raw:
            params[parameter.key] = raw

    currency = request.query_params.get("currency")
    if currency:
        params["currency"] = currency
    return params


class ReportCatalogView(APIView):
    """`GET /api/v1/reports` — каталог отчётов `[ТЗ 3.6.1]`."""

    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "default": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL)
    }

    @extend_schema(
        summary="Каталог отчётов",
        responses={200: ReportDefinitionSerializer(many=True)},
        tags=["reports"],
    )
    def get(self, request: Request) -> Response:
        return Response(
            {"data": [spec.to_contract() for spec in definitions.DEFINITIONS.values()]}
        )


class ReportBuildView(APIView):
    """`GET /api/v1/reports/{code}` — построение отчёта `[ТЗ 3.6.1]`."""

    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "default": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL)
    }

    @extend_schema(
        summary="Построение отчёта",
        responses={200: ReportResultSerializer, 404: ErrorResponseSerializer},
        tags=["reports"],
    )
    def get(self, request: Request, code: str) -> Response:
        if code not in definitions.DEFINITIONS:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": "Отчёт не найден", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )

        check_report_permission(request, code)
        return Response(builders.build(code, _parse_params(request, code)))


class ReportExportView(IdempotencyMixin, APIView):
    """`POST /api/v1/reports/{code}/export` `[ТЗ 3.6.3]`."""

    idempotency: ClassVar[str] = "required"
    permission_classes: Any = (HasRolePermission,)
    required_permissions: ClassVar[dict[str, Any]] = {
        "default": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL)
    }

    @extend_schema(
        summary="Выгрузка отчёта",
        request=ReportExportSerializer,
        responses={
            202: ExportTicketSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["reports"],
    )
    def post(self, request: Request, code: str) -> Response:
        if code not in definitions.DEFINITIONS:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": "Отчёт не найден", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )

        # До идемпотентности: отказ в праве не кэшируется как результат.
        check_report_permission(request, code)

        def produce() -> Response:
            payload = ReportExportSerializer(data=request.data)
            payload.is_valid(raise_exception=True)

            params = _parse_params(request, code)
            result = builders.build(code, params)
            produced = export.export_report(
                code=code,
                result=result,
                export_format=payload.validated_data["format"],
                params=params,
            )

            from core.services import storage

            return Response(
                {
                    "taskId": f"{code}-{clock.now():%Y%m%d%H%M%S}",
                    "status": "ready",
                    "downloadUrl": produced.url,
                    "expiresAt": clock.now()
                    + timedelta(seconds=storage.DOWNLOAD_URL_TTL_SECONDS),
                },
                status=status.HTTP_202_ACCEPTED,
            )

        return self.idempotent(request, produce)


@extend_schema_view(
    list=extend_schema(summary="Подписки на отчёты", tags=["reports"]),
    create=extend_schema(summary="Создание подписки", tags=["reports"]),
    partial_update=extend_schema(
        summary="Изменение подписки",
        tags=["reports"],
        responses={200: ReportSubscriptionSerializer, 404: ErrorResponseSerializer},
    ),
    destroy=extend_schema(
        summary="Отписка",
        tags=["reports"],
        responses={204: None, 404: ErrorResponseSerializer},
    ),
)
class ReportSubscriptionViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/report-subscriptions` `[ТЗ 3.6.3]`."""

    http_method_names = ["get", "post", "patch", "delete", "head", "options"]  # noqa: RUF012
    queryset = ReportSubscription.objects.filter(is_active=True)
    serializer_class = ReportSubscriptionSerializer
    idempotency = "required"
    pagination_class = None
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL),
        "create": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL),
        "partial_update": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL),
        "destroy": (Permission.REPORTS_OPERATIONAL, Permission.REPORTS_FINANCIAL),
    }

    def get_queryset(self) -> QuerySet[ReportSubscription]:
        return cast(QuerySet[ReportSubscription], super().get_queryset())

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response({"data": self.get_serializer(self.get_queryset(), many=True).data})

    def perform_create(self, serializer: Any) -> None:
        subscription = serializer.save()
        audit.record(
            entity_type="report_subscription",
            entity_id=subscription.pk,
            action="created",
            actor=cast(User, self.request.user),
            after=audit.snapshot(subscription),
        )

    def perform_update(self, serializer: Any) -> None:
        before = audit.snapshot(serializer.instance)
        subscription = serializer.save()
        audit.record(
            entity_type="report_subscription",
            entity_id=subscription.pk,
            action="updated",
            actor=cast(User, self.request.user),
            before=before,
            after=audit.snapshot(subscription),
        )

    def perform_destroy(self, instance: ReportSubscription) -> None:
        """Отписка — снятие признака, а не удаление записи.

        История отправок ссылается на подписку, и удалять её из базы
        значило бы обрывать эти ссылки.
        """
        before = audit.snapshot(instance)
        instance.is_active = False
        instance.save(update_fields=["is_active", "updated_at", "version"])
        audit.record(
            entity_type="report_subscription",
            entity_id=instance.pk,
            action="deactivated",
            actor=cast(User, self.request.user),
            before=before,
            after=audit.snapshot(instance),
        )
