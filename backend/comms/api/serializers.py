"""Формы обмена модуля коммуникаций `[ТЗ 3.5]`.

Имена полей — как в `openapi.yaml`: контракт согласован с клиентами
до кода (`CLAUDE.md § 3` п. 6).
"""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from comms.models import InboxMessage, MessageTemplate, Notification, OutboxMessage
from comms.services import outbox as outbox_service


class NotificationSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    readAt = serializers.DateTimeField(source="read_at", allow_null=True)  # noqa: N815
    createdAt = serializers.DateTimeField(source="created_at")  # noqa: N815

    class Meta:
        model = Notification
        fields = ("id", "kind", "severity", "title", "body", "link", "readAt", "createdAt")


class AttachmentRefSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`AttachmentRef` из контракта."""

    id = serializers.CharField()
    fileName = serializers.CharField(source="file_name")  # noqa: N815
    mimeType = serializers.CharField(source="mime_type")  # noqa: N815
    sizeBytes = serializers.IntegerField(source="size_bytes")  # noqa: N815


class OutboxMessageSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    channelMode = serializers.CharField(source="channel_mode")  # noqa: N815
    templateCode = serializers.CharField(source="template_code")  # noqa: N815
    lastError = serializers.SerializerMethodField()  # noqa: N815
    sentAt = serializers.DateTimeField(source="sent_at", allow_null=True)  # noqa: N815
    relatedTo = serializers.SerializerMethodField()  # noqa: N815
    attachments = serializers.SerializerMethodField()
    emlUrl = serializers.SerializerMethodField()  # noqa: N815

    class Meta:
        model = OutboxMessage
        fields = (
            "id",
            "channel",
            "channelMode",
            "to",
            "templateCode",
            "subject",
            "body",
            "attachments",
            "relatedTo",
            "status",
            "attempts",
            "lastError",
            "sentAt",
            "emlUrl",
        )

    def get_lastError(self, obj: OutboxMessage) -> str | None:  # noqa: N802
        return obj.last_error or None

    def get_relatedTo(self, obj: OutboxMessage) -> dict[str, str] | None:  # noqa: N802
        if not obj.related_entity_type:
            return None
        return {"entityType": obj.related_entity_type, "entityId": obj.related_entity_id}

    def get_attachments(self, obj: OutboxMessage) -> list[dict[str, Any]]:
        return [
            AttachmentRefSerializer(attachment).data
            for attachment in obj.attachments.all()
            if attachment.uploaded_at is not None
        ]

    def get_emlUrl(self, obj: OutboxMessage) -> str | None:  # noqa: N802
        """Подписанная ссылка на письмо.

        Считается при выдаче, а не хранится: ссылка живёт четверть часа,
        и сохранённая была бы просроченной к моменту нажатия.
        """
        return outbox_service.eml_url(obj)


class InboxMessageSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    # `from` — ключевое слово Python, поэтому поле объявляется через имя
    # источника, а наружу идёт так, как требует контракт.
    receivedAt = serializers.DateTimeField(source="received_at")  # noqa: N815
    serviceOrderId = serializers.CharField(  # noqa: N815
        source="service_order_id", allow_null=True
    )
    suggestedAction = serializers.SerializerMethodField()  # noqa: N815
    appliedAt = serializers.DateTimeField(source="applied_at", allow_null=True)  # noqa: N815

    class Meta:
        model = InboxMessage
        fields = (
            "id",
            "channel",
            "subject",
            "body",
            "receivedAt",
            "recognized",
            "serviceOrderId",
            "suggestedAction",
            "appliedAt",
        )

    def get_suggestedAction(self, obj: InboxMessage) -> str | None:  # noqa: N802
        return obj.suggested_action or None

    def to_representation(self, instance: InboxMessage) -> dict[str, Any]:
        data = super().to_representation(instance)
        data["from"] = instance.sender
        return data


class InboxApplySerializer(serializers.Serializer):  # type: ignore[type-arg]
    serviceOrderId = serializers.CharField(required=False, allow_blank=True)  # noqa: N815
    transition = serializers.CharField(required=False, allow_blank=True)


class LocalizedNameSerializer(serializers.Serializer):  # type: ignore[type-arg]
    ru = serializers.CharField()
    en = serializers.CharField()


class MessageTemplateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    subject = serializers.SerializerMethodField()
    body = serializers.SerializerMethodField()

    class Meta:
        model = MessageTemplate
        fields = ("id", "code", "channel", "subject", "body", "variables")
        read_only_fields = ("id", "code", "variables")

    def get_subject(self, obj: MessageTemplate) -> dict[str, str]:
        return {"ru": obj.subject_ru, "en": obj.subject_en}

    def get_body(self, obj: MessageTemplate) -> dict[str, str]:
        return {"ru": obj.body_ru, "en": obj.body_en}


class MessageTemplateUpdateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Изменение шаблона.

    Код и канал не меняются: на код ссылается доменный код, отправляющий
    сообщение, а смена канала у существующего шаблона означала бы другой
    шаблон, а не правку этого.
    """

    subject = LocalizedNameSerializer()
    body = LocalizedNameSerializer()


class TemplatePreviewSerializer(serializers.Serializer):  # type: ignore[type-arg]
    flightId = serializers.CharField()  # noqa: N815
    locale = serializers.ChoiceField(choices=["ru", "en"], required=False, default="ru")
