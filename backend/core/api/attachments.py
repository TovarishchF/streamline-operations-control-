"""Эндпоинты вложений `[ТЗ 3.3.3, 3.2.2]`.

`POST /attachments` — завести вложение и получить ссылку на загрузку,
`POST /attachments/{id}/confirm` — подтвердить, что файл дошёл.

Файл идёт из браузера прямо в хранилище (ADR-007): приложение выдаёт
подписанную ссылку и проверяет результат, но байты через себя не пропускает.
"""

from __future__ import annotations

from typing import Any, ClassVar

from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.idempotency import IdempotentCreateMixin
from core.api.serializers import ErrorResponseSerializer
from core.models import Attachment, AttachmentKind
from core.services import attachments as service
from core.services import storage


class AttachmentRefSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`AttachmentRef` из `openapi.yaml`."""

    fileName = serializers.CharField(source="file_name")  # noqa: N815
    mimeType = serializers.CharField(source="mime_type")  # noqa: N815
    sizeBytes = serializers.IntegerField(source="size_bytes")  # noqa: N815
    storageKey = serializers.CharField(source="storage_key")  # noqa: N815
    uploadedAt = serializers.DateTimeField(source="uploaded_at", allow_null=True)  # noqa: N815
    uploadedBy = serializers.CharField(source="uploaded_by_id", allow_null=True)  # noqa: N815
    downloadUrl = serializers.SerializerMethodField()  # noqa: N815

    class Meta:
        model = Attachment
        fields = (
            "id", "fileName", "mimeType", "sizeBytes", "kind",
            "storageKey", "downloadUrl", "uploadedAt", "uploadedBy",
        )

    def get_downloadUrl(self, obj: Attachment) -> str | None:  # noqa: N802
        """Подписанная ссылка со сроком жизни. У незагруженного файла её нет."""
        if obj.uploaded_at is None:
            return None
        return service.download_url(obj)


class AttachmentCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    fileName = serializers.CharField(max_length=255)  # noqa: N815
    mimeType = serializers.CharField(max_length=128)  # noqa: N815
    sizeBytes = serializers.IntegerField(min_value=1)  # noqa: N815
    kind = serializers.ChoiceField(choices=AttachmentKind.choices, default=AttachmentKind.OTHER)


class AttachmentUploadSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Ответ на заведение вложения: запись плюс ссылка на загрузку."""

    attachment = AttachmentRefSerializer()
    uploadUrl = serializers.CharField()  # noqa: N815
    expiresInSeconds = serializers.IntegerField()  # noqa: N815


class AttachmentCreateView(IdempotentCreateMixin, APIView):
    """`POST /api/v1/attachments`.

    Право не проверяется отдельным разрешением: завести вложение может
    любой, кто вошёл в систему, а вот привязать его к договору или заявке —
    только тот, у кого есть право на этот договор или заявку. Осиротевшее
    вложение никому не видно и удаляется по сроку.
    """

    idempotency: ClassVar[str] = "optional"
    # Здесь намеренно IsAuthenticated, а не карта ролей: завести вложение
    # может любой вошедший, а вот привязать его к договору или заявке —
    # только тот, у кого есть право на сам договор или заявку. Требовать
    # право здесь значило бы заводить отдельное разрешение под операцию,
    # которая сама по себе ничего не открывает.
    permission_classes: Any = (IsAuthenticated,)

    @extend_schema(
        summary="Завести вложение и получить ссылку на загрузку",
        request=AttachmentCreateSerializer,
        responses={201: AttachmentUploadSerializer, 400: ErrorResponseSerializer},
        tags=["attachments"],
    )
    def post(self, request: Request) -> Response:
        def produce() -> Response:
            payload = AttachmentCreateSerializer(data=request.data)
            payload.is_valid(raise_exception=True)
            data = payload.validated_data

            attachment, upload_url = service.reserve(
                file_name=data["fileName"],
                mime_type=data["mimeType"],
                size_bytes=data["sizeBytes"],
                kind=data["kind"],
                actor=request.user,  # type: ignore[arg-type]
            )
            return Response(
                {
                    "attachment": AttachmentRefSerializer(attachment).data,
                    "uploadUrl": upload_url,
                    "expiresInSeconds": storage.UPLOAD_URL_TTL_SECONDS,
                },
                status=status.HTTP_201_CREATED,
            )

        return self.idempotent(request, produce)


class AttachmentConfirmView(APIView):
    """`POST /api/v1/attachments/{id}/confirm`.

    Подтверждает, что файл действительно лежит в хранилище. До этого
    вложение считается незавершённым и к владельцу не привязывается.
    """

    permission_classes: Any = (IsAuthenticated,)

    @extend_schema(
        summary="Подтвердить загрузку вложения",
        request=None,
        responses={
            200: AttachmentRefSerializer,
            400: ErrorResponseSerializer,
            404: ErrorResponseSerializer,
        },
        tags=["attachments"],
    )
    def post(self, request: Request, attachment_id: str) -> Response:
        # Подтвердить можно только своё вложение: чужой идентификатор
        # не должен давать подписанную ссылку на чужой файл.
        attachment = Attachment.objects.filter(
            pk=attachment_id, uploaded_by_id=request.user.pk
        ).first()
        if attachment is None:
            return Response(
                {"error": {"code": "NOT_FOUND", "message": "Вложение не найдено", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response(AttachmentRefSerializer(service.confirm(attachment=attachment)).data)
