"""Сериализаторы, общие для всех модулей.

Нужны генератору схемы: без них drf-spectacular подставляет `string` вместо
описанных в контракте структур, и проверка расхождения теряет смысл.
"""

from __future__ import annotations

from rest_framework import serializers


class ErrorDetailSerializer(serializers.Serializer):  # type: ignore[type-arg]
    code = serializers.CharField()
    message = serializers.CharField()
    details = serializers.DictField(required=False)


class ErrorResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Формат ошибки из `BACKEND.md § 9` и `openapi.yaml`."""

    error = ErrorDetailSerializer()


class TokenPairSerializer(serializers.Serializer):  # type: ignore[type-arg]
    access = serializers.CharField()
    refresh = serializers.CharField()
    expiresIn = serializers.IntegerField()  # noqa: N815


class LoginResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    twoFactorRequired = serializers.BooleanField()  # noqa: N815
    twoFactorToken = serializers.CharField(allow_null=True)  # noqa: N815
    tokens = TokenPairSerializer(allow_null=True)


class TwoFactorSetupSerializer(serializers.Serializer):  # type: ignore[type-arg]
    secret = serializers.CharField()
    otpauthUrl = serializers.CharField()  # noqa: N815
    backupCodes = serializers.ListField(child=serializers.CharField())  # noqa: N815
