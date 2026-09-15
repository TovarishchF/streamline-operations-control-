"""Эндпоинты модуля коммуникаций `[ТЗ 3.5.1, 3.5.2, 3.2.2]`.

`/notifications`, `/outbox`, `/inbox`, `/message-templates` — пути и формы
по `openapi.yaml`.

Уведомления адресные: выборка всегда ограничена текущим пользователем,
и не признаком роли, а связью. Чужие уведомления не показываются никому,
включая администратора: колокольчик — личный экран, а не журнал системы,
для журнала есть аудит.
"""

from __future__ import annotations

from typing import Any, ClassVar, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import Permission
from audit import services as audit
from comms.api.serializers import (
    InboxApplySerializer,
    InboxMessageSerializer,
    MessageTemplateSerializer,
    MessageTemplateUpdateSerializer,
    NotificationSerializer,
    OutboxMessageSerializer,
    TemplatePreviewSerializer,
)
from comms.models import InboxMessage, MessageTemplate, Notification, OutboxMessage
from comms.services import context as template_context
from comms.services import inbox as inbox_service
from comms.services import notifications as notification_service
from comms.services import outbox as outbox_service
from comms.services import templates as template_service
from core.api.idempotency import IdempotencyMixin
from core.api.serializers import ErrorResponseSerializer
from core.api.viewsets import SocViewSetMixin


@extend_schema_view(
    list=extend_schema(summary="Внутренние уведомления", tags=["comms"]),
)
class NotificationViewSet(
    SocViewSetMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/notifications` `[ТЗ 3.5.1]`."""

    queryset = Notification.objects.all()
    serializer_class = NotificationSerializer
    # Уведомления получают все вошедшие, включая порталы: событие по своей
    # заявке поставщик видеть обязан. Ограничение — связью с пользователем.
    required_permissions: ClassVar[dict[str, Any]] = {}

    def get_queryset(self) -> QuerySet[Notification]:
        queryset = cast(QuerySet[Notification], super().get_queryset()).filter(
            user=cast(User, self.request.user)
        )
        if self.request.query_params.get("unreadOnly") in ("true", "1"):
            queryset = queryset.filter(read_at__isnull=True)
        kind = self.request.query_params.get("kind")
        if kind:
            queryset = queryset.filter(kind=kind)
        return queryset

    @extend_schema(
        summary="Отметка уведомления прочитанным",
        request=None,
        responses={204: None, 404: ErrorResponseSerializer},
        tags=["comms"],
    )
    @action(detail=True, methods=["post"], url_path="read")
    def read(self, request: Request, pk: str | None = None) -> Response:
        notification_service.mark_read(notification=self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema_view(
    list=extend_schema(summary="Очередь исходящих сообщений", tags=["comms"]),
)
class OutboxViewSet(
    SocViewSetMixin,
    IdempotencyMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/outbox` `[ТЗ 3.5.2]`."""

    queryset = OutboxMessage.objects.prefetch_related("attachments").all()
    serializer_class = OutboxMessageSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.COMMS_VIEW}

    def get_queryset(self) -> QuerySet[OutboxMessage]:
        queryset = cast(QuerySet[OutboxMessage], super().get_queryset())
        channel = self.request.query_params.get("channel")
        if channel:
            queryset = queryset.filter(channel=channel)
        message_status = self.request.query_params.get("status")
        if message_status:
            queryset = queryset.filter(status=message_status)
        return queryset

    @extend_schema(
        summary="Повторная отправка сообщения",
        request=None,
        responses={
            200: OutboxMessageSerializer,
            409: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["comms"],
    )
    @action(detail=True, methods=["post"])
    def retry(self, request: Request, pk: str | None = None) -> Response:
        message = self.get_object()

        def produce() -> Response:
            sent = outbox_service.retry(
                message=message, actor=cast(User, request.user)
            )
            return Response(OutboxMessageSerializer(sent).data)

        return self.idempotent(request, produce)


@extend_schema_view(
    list=extend_schema(summary="Входящие внешние события", tags=["comms"]),
)
class InboxViewSet(
    SocViewSetMixin,
    IdempotencyMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/inbox` `[ТЗ 3.2.2]`."""

    queryset = InboxMessage.objects.select_related("service_order").all()
    serializer_class = InboxMessageSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.COMMS_VIEW}

    def get_queryset(self) -> QuerySet[InboxMessage]:
        queryset = cast(QuerySet[InboxMessage], super().get_queryset())
        if self.request.query_params.get("unrecognizedOnly") in ("true", "1"):
            queryset = queryset.filter(recognized=False)
        return queryset

    @extend_schema(
        summary="Применение входящего события к заявке",
        request=InboxApplySerializer,
        responses={
            200: InboxMessageSerializer,
            409: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["comms"],
    )
    @action(detail=True, methods=["post"])
    def apply(self, request: Request, pk: str | None = None) -> Response:
        message = self.get_object()

        def produce() -> Response:
            payload = InboxApplySerializer(data=request.data)
            payload.is_valid(raise_exception=True)

            order = None
            order_id = payload.validated_data.get("serviceOrderId")
            if order_id:
                from orders.models import ServiceOrder

                order = ServiceOrder.objects.filter(pk=order_id).first()
                if order is None:
                    return Response(
                        {
                            "error": {
                                "code": "NOT_FOUND",
                                "message": "Заявка не найдена",
                                "details": {"serviceOrderId": order_id},
                            }
                        },
                        status=status.HTTP_404_NOT_FOUND,
                    )

            applied = inbox_service.apply(
                message=message,
                actor=cast(User, request.user),
                service_order=order,
                transition=payload.validated_data.get("transition", ""),
            )
            return Response(InboxMessageSerializer(applied).data)

        return self.idempotent(request, produce)


@extend_schema_view(
    list=extend_schema(summary="Шаблоны сообщений", tags=["comms"]),
    partial_update=extend_schema(
        summary="Изменение шаблона",
        request=MessageTemplateUpdateSerializer,
        responses={200: MessageTemplateSerializer, 404: ErrorResponseSerializer},
        tags=["comms"],
    ),
)
class MessageTemplateViewSet(
    SocViewSetMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/message-templates` `[ТЗ 3.5.2]`."""

    http_method_names = ["get", "post", "patch", "head", "options"]  # noqa: RUF012
    queryset = MessageTemplate.objects.all()
    serializer_class = MessageTemplateSerializer
    pagination_class = None
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.COMMS_VIEW,
        "partial_update": Permission.COMMS_TEMPLATES_EDIT,
        "preview": Permission.COMMS_VIEW,
    }

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response({"data": self.get_serializer(self.get_queryset(), many=True).data})

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        template = self.get_object()
        payload = MessageTemplateUpdateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        before = audit.snapshot(template)
        template.subject_ru = payload.validated_data["subject"]["ru"]
        template.subject_en = payload.validated_data["subject"]["en"]
        template.body_ru = payload.validated_data["body"]["ru"]
        template.body_en = payload.validated_data["body"]["en"]
        # Перечень переменных пересобирается из текста: держать его отдельно
        # значит получить редактор, предлагающий подстановки, которых
        # в шаблоне уже нет.
        template.variables = template_service.variables_in(template)
        template.save()

        audit.record(
            entity_type="message_template",
            entity_id=template.pk,
            action="updated",
            actor=cast(User, request.user),
            before=before,
            after=audit.snapshot(template),
        )
        return Response(MessageTemplateSerializer(template).data)

    @extend_schema(
        summary="Предпросмотр шаблона на выбранном рейсе",
        request=TemplatePreviewSerializer,
        responses={200: None, 404: ErrorResponseSerializer},
        tags=["comms"],
    )
    @action(detail=True, methods=["post"])
    def preview(self, request: Request, pk: str | None = None) -> Response:
        """Шаблон, собранный на настоящих данных рейса `[ТЗ 3.5.2]`.

        Возвращается и список неподставленных переменных: письмо с дырой
        посреди фразы уходить поставщику не должно, и увидеть дыру нужно
        здесь, а не у получателя.
        """
        template = self.get_object()
        payload = TemplatePreviewSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        from flights.models import Flight

        flight = Flight.objects.filter(pk=payload.validated_data["flightId"]).first()
        if flight is None:
            return Response(
                {
                    "error": {
                        "code": "NOT_FOUND",
                        "message": "Рейс не найден",
                        "details": {"flightId": payload.validated_data["flightId"]},
                    }
                },
                status=status.HTTP_404_NOT_FOUND,
            )

        rendered = template_service.render_template(
            template,
            locale=payload.validated_data["locale"],
            data=template_context.for_flight(flight),
        )
        return Response(
            {"subject": rendered.subject, "body": rendered.body, "missing": rendered.missing}
        )
