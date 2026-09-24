"""Сериализаторы учётных записей. Форма — по `openapi.yaml`."""

from __future__ import annotations

from typing import Any

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from accounts.models import RegistrationRequest, Role, User
from accounts.permissions import permission_map


class UserSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    name = serializers.SerializerMethodField()
    organizationId = serializers.CharField(source="organization_id", read_only=True)  # noqa: N815
    clientId = serializers.CharField(source="client_id", read_only=True)  # noqa: N815
    vendorId = serializers.CharField(source="vendor_id", read_only=True)  # noqa: N815
    timezoneMode = serializers.CharField(source="timezone_mode")  # noqa: N815
    twoFactorEnabled = serializers.BooleanField(source="two_factor_enabled")  # noqa: N815
    isActive = serializers.BooleanField(source="is_active")  # noqa: N815

    class Meta:
        model = User
        fields = (
            "id", "name", "email", "role", "organizationId", "clientId", "vendorId",
            "locale", "timezoneMode", "timezone", "twoFactorEnabled", "isActive",
        )

    def get_name(self, obj: User) -> str:
        return obj.get_full_name() or obj.username


class UserCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Заведение пользователя администратором.

    Пароль не передаётся: он задаётся владельцем учётной записи по ссылке
    восстановления. Администратор, знающий чужой пароль, обесценивает аудит —
    по журналу нельзя понять, кто совершил действие.
    """

    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=Role.choices)
    clientId = serializers.CharField(required=False, allow_null=True)  # noqa: N815
    vendorId = serializers.CharField(required=False, allow_null=True)  # noqa: N815
    locale = serializers.ChoiceField(choices=[("ru", "ru"), ("en", "en")], default="ru")
    timezone = serializers.CharField(default="UTC")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        role = attrs["role"]
        if role == Role.CLIENT and not attrs.get("clientId"):
            raise serializers.ValidationError(
                {"clientId": "Для роли «Клиент» нужно указать клиента: по нему "
                             "ограничивается видимость данных"}
            )
        if role == Role.VENDOR and not attrs.get("vendorId"):
            raise serializers.ValidationError(
                {"vendorId": "Для роли «Поставщик» нужно указать поставщика: по нему "
                             "ограничивается видимость данных"}
            )
        # ADR-011: роль объявлена, но до подтверждения заказчиком (G-06)
        # пользователи с ней не заводятся.
        if role == Role.SALES:
            raise serializers.ValidationError(
                {"role": "Роль «Продажи» ожидает подтверждения заказчиком (G-06), "
                         "пользователи с ней пока не создаются"}
            )
        return attrs


class LoginSerializer(serializers.Serializer):  # type: ignore[type-arg]
    username = serializers.CharField()
    password = serializers.CharField(style={"input_type": "password"}, trim_whitespace=False)


class TwoFactorSerializer(serializers.Serializer):  # type: ignore[type-arg]
    twoFactorToken = serializers.CharField()  # noqa: N815
    code = serializers.CharField()


class RefreshSerializer(serializers.Serializer):  # type: ignore[type-arg]
    refresh = serializers.CharField()


class MeSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Профиль и карта прав `[ТЗ 4.3]`."""

    user = UserSerializer(read_only=True)
    permissions = serializers.SerializerMethodField()
    demoMode = serializers.BooleanField(read_only=True)  # noqa: N815
    twoFactorSetupRequired = serializers.SerializerMethodField()  # noqa: N815

    def get_permissions(self, obj: dict[str, Any]) -> dict[str, bool]:
        return permission_map(obj["user"].role)

    def get_twoFactorSetupRequired(self, obj: dict[str, Any]) -> bool:  # noqa: N802
        """Политика требует второй фактор, а приложение не привязано.

        Клиент по этому признаку не пускает пользователя никуда, кроме
        экрана привязки. Признак вычисляется на сервере: политика ролей —
        серверное знание.
        """
        from accounts.services import two_factor_setup_required

        return two_factor_setup_required(obj["user"])


class PasswordChangeSerializer(serializers.Serializer):  # type: ignore[type-arg]
    currentPassword = serializers.CharField(trim_whitespace=False)  # noqa: N815
    newPassword = serializers.CharField(trim_whitespace=False)  # noqa: N815

    def validate_newPassword(self, value: str) -> str:  # noqa: N802
        """Политика паролей — стандартные проверки Django из настроек.

        Минимальная длина 12 символов, отказ от распространённых и полностью
        числовых паролей, проверка на совпадение с данными учётной записи
        (`BACKEND.md § 6`).
        """
        try:
            validate_password(value, user=self.context.get("user"))
        except DjangoValidationError as error:
            raise serializers.ValidationError(list(error.messages)) from error
        return value


class DemoAccountSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Учётная запись в списке экрана входа.

    Пароля здесь нет: список экономит набор логина, а не заменяет вход.
    """

    username = serializers.CharField()
    name = serializers.CharField()
    role = serializers.CharField()


class DemoAccountListSerializer(serializers.Serializer):  # type: ignore[type-arg]
    # `ListSerializer` в поле формы: у `Serializer` атрибут `data` объявлен
    # как готовый словарь ответа, и переопределение его полем — конфликт имён,
    # а не ошибка. Форма ответа описана контрактом.
    data = DemoAccountSerializer(many=True)  # type: ignore[assignment]


class RegistrationSubmitSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`RegistrationRequest` из контракта — форма подачи."""

    kind = serializers.ChoiceField(choices=["client", "vendor"])
    contactName = serializers.CharField(max_length=255)  # noqa: N815
    email = serializers.EmailField()
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    password = serializers.CharField(trim_whitespace=False, write_only=True)

    companyName = serializers.CharField(max_length=255)  # noqa: N815
    legalName = serializers.CharField(  # noqa: N815
        max_length=500, required=False, allow_blank=True, default=""
    )
    country = serializers.CharField(max_length=2, required=False, allow_blank=True, default="")
    taxId = serializers.CharField(  # noqa: N815
        max_length=32, required=False, allow_blank=True, default=""
    )
    website = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")

    specializations = serializers.ListField(
        child=serializers.CharField(max_length=16), required=False, default=list
    )
    coverageAirports = serializers.ListField(  # noqa: N815
        child=serializers.RegexField(r"^[A-Za-z]{4}$"), required=False, default=list
    )
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_password(self, value: str) -> str:
        """Та же политика, что и при смене пароля.

        Слабый пароль, заведённый через регистрацию, ничем не лучше
        слабого пароля, заведённого администратором.
        """
        try:
            validate_password(value)
        except DjangoValidationError as error:
            raise serializers.ValidationError(list(error.messages)) from error
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["kind"] == "vendor" and not attrs.get("specializations"):
            # Поставщик без категорий непонятно чем занимается, и решение
            # о нём принять нельзя.
            raise serializers.ValidationError(
                {"specializations": "Укажите хотя бы одну категорию услуг."}
            )
        return attrs


class RegistrationConfirmSerializer(serializers.Serializer):  # type: ignore[type-arg]
    requestId = serializers.CharField()  # noqa: N815
    token = serializers.CharField()


class RegistrationRequestSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Заявка в очереди на согласование. Пароля в ответе нет."""

    contactName = serializers.CharField(source="contact_name")  # noqa: N815
    companyName = serializers.CharField(source="company_name")  # noqa: N815
    legalName = serializers.CharField(source="legal_name")  # noqa: N815
    taxId = serializers.CharField(source="tax_id")  # noqa: N815
    coverageAirports = serializers.JSONField(source="coverage_airports")  # noqa: N815
    emailConfirmedAt = serializers.DateTimeField(  # noqa: N815
        source="email_confirmed_at", allow_null=True
    )
    createdAt = serializers.DateTimeField(source="created_at")  # noqa: N815
    decisionReason = serializers.CharField(source="decision_reason")  # noqa: N815

    class Meta:
        model = RegistrationRequest
        fields = (
            "id", "kind", "status", "contactName", "email", "phone",
            "companyName", "legalName", "country", "taxId", "website",
            "specializations", "coverageAirports", "comment",
            "emailConfirmedAt", "createdAt", "decisionReason",
        )


class RegistrationDecisionSerializer(serializers.Serializer):  # type: ignore[type-arg]
    reason = serializers.CharField(required=False, allow_blank=True, default="")
