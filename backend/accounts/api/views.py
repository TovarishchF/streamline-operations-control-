"""Эндпоинты входа и учётных записей `[ТЗ 4.3]`.

`/auth/*` и `/users` по `openapi.yaml`. Логика — в `accounts.services`,
вьюха разбирает вход и возвращает результат (`CLAUDE.md § 3` п. 10).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, ClassVar, cast

from django.conf import settings
from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, status, viewsets
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from accounts import services
from accounts.api.serializers import (
    DemoAccountListSerializer,
    LoginSerializer,
    MeSerializer,
    PasswordChangeSerializer,
    RefreshSerializer,
    TwoFactorSerializer,
    UserCreateSerializer,
    UserSerializer,
)
from accounts.models import Role, User
from accounts.permissions import Permission
from audit import services as audit
from audit.models import AuditEntityType
from core.api.idempotency import IdempotentCreateMixin
from core.api.serializers import (
    ErrorResponseSerializer,
    LoginResponseSerializer,
    TokenPairSerializer,
    TwoFactorSetupSerializer,
)
from core.api.viewsets import SocViewSetMixin
from core.exceptions import AuthenticationFailed
from counterparties.models import Client, Vendor


def _token_pair(pair: services.TokenPair) -> dict[str, Any]:
    return {"access": pair.access, "refresh": pair.refresh, "expiresIn": pair.expires_in}


class LoginView(APIView):
    """`POST /api/v1/auth/login`.

    Первый шаг. Блокировка после пяти неудачных попыток — 423, чтобы клиент
    отличал «не тот пароль» от «подождите пятнадцать минут».
    """

    permission_classes = (AllowAny,)
    authentication_classes = ()

    @extend_schema(
        request=LoginSerializer,
        responses={
            200: LoginResponseSerializer,
            401: ErrorResponseSerializer,
            423: ErrorResponseSerializer,
        },
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = services.login(
            serializer.validated_data["username"], serializer.validated_data["password"]
        )
        payload: dict[str, Any] = {
            "twoFactorRequired": result.two_factor_required,
            "twoFactorToken": result.two_factor_token,
            "tokens": _token_pair(result.tokens) if result.tokens else None,
        }
        return Response(payload)


class TwoFactorView(APIView):
    """`POST /api/v1/auth/2fa`. Код из приложения либо резервный код."""

    permission_classes = (AllowAny,)
    authentication_classes = ()

    @extend_schema(
        request=TwoFactorSerializer,
        responses={200: TokenPairSerializer, 401: ErrorResponseSerializer},
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        serializer = TwoFactorSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        pair = services.verify_two_factor(
            serializer.validated_data["twoFactorToken"], serializer.validated_data["code"]
        )
        return Response(_token_pair(pair))


class RefreshView(APIView):
    """`POST /api/v1/auth/refresh`. Refresh ротируется, старый попадает в список отзыва."""

    permission_classes = (AllowAny,)
    authentication_classes = ()

    @extend_schema(
        request=RefreshSerializer,
        responses={200: TokenPairSerializer, 401: ErrorResponseSerializer},
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        serializer = RefreshSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            refresh = RefreshToken(serializer.validated_data["refresh"])
        except TokenError as error:
            raise AuthenticationFailed(
                "Токен обновления недействителен, войдите заново"
            ) from error

        access = refresh.access_token
        if settings.SIMPLE_JWT.get("ROTATE_REFRESH_TOKENS"):
            if settings.SIMPLE_JWT.get("BLACKLIST_AFTER_ROTATION"):
                refresh.blacklist()
            user = User.objects.filter(pk=refresh.payload.get("user_id")).first()
            if user is None or not user.is_active:
                raise AuthenticationFailed("Учётная запись недоступна")
            return Response(_token_pair(services.issue_tokens(user)))

        lifetime = cast(timedelta, settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"])
        return Response(
            {
                "access": str(access),
                "refresh": str(refresh),
                "expiresIn": int(lifetime.total_seconds()),
            }
        )


class LogoutView(APIView):
    """`POST /api/v1/auth/logout`."""

    permission_classes = (IsAuthenticated,)

    @extend_schema(request=RefreshSerializer, responses={204: None}, tags=["auth"])
    def post(self, request: Request) -> Response:
        serializer = RefreshSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        services.logout(serializer.validated_data["refresh"])
        audit.record(
            entity_type=AuditEntityType.USER,
            entity_id=str(request.user.pk),
            action="logged_out",
            actor=cast(User, request.user),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    """`GET /api/v1/auth/me`. Профиль и карта прав."""

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        responses={200: MeSerializer, 401: ErrorResponseSerializer}, tags=["auth"]
    )
    def get(self, request: Request) -> Response:
        payload = {"user": request.user, "demoMode": settings.DEMO_DATA}
        return Response(MeSerializer(payload).data)


class AccountListView(APIView):
    """`GET /api/v1/auth/accounts`. Учётные записи для экрана входа.

    Стенд показывают нескольким людям подряд, и каждому приходится
    вспоминать чужой логин. Список отдаёт **только** имя, логин и роль:
    паролей здесь нет и быть не может — вход остаётся настоящим,
    обход аутентификации запрещён (ADR-013).

    Вне `DEMO_ACCOUNTS=true` список пуст. Перечень действующих сотрудников
    организации — не публичные данные.
    """

    authentication_classes: Any = ()
    permission_classes: Any = (AllowAny,)

    @extend_schema(
        summary="Учётные записи стенда для экрана входа",
        responses={200: DemoAccountListSerializer},
        tags=["auth"],
    )
    def get(self, request: Request) -> Response:
        if not settings.DEMO_ACCOUNTS:
            return Response({"data": []})

        users = User.objects.filter(is_active=True).order_by("role", "username")
        return Response(
            {
                "data": [
                    {
                        "username": user.username,
                        "name": user.get_full_name() or user.username,
                        "role": user.role,
                    }
                    for user in users
                ]
            }
        )


class TwoFactorSetupView(APIView):
    """`POST /api/v1/auth/2fa/setup`. Привязка приложения и резервные коды."""

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        request=None, responses={200: TwoFactorSetupSerializer}, tags=["auth"]
    )
    def post(self, request: Request) -> Response:
        setup = services.setup_two_factor(cast(User, request.user))
        return Response(
            {
                "secret": setup.secret,
                "otpauthUrl": setup.otpauth_url,
                "backupCodes": setup.backup_codes,
            }
        )


class PasswordChangeView(APIView):
    """`POST /api/v1/auth/password`. Смена пароля владельцем учётной записи."""

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        request=PasswordChangeSerializer,
        responses={
            204: None,
            400: ErrorResponseSerializer,
            401: ErrorResponseSerializer,
        },
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        serializer = PasswordChangeSerializer(data=request.data, context={"user": request.user})
        serializer.is_valid(raise_exception=True)

        user = cast(User, request.user)
        if not user.check_password(serializer.validated_data["currentPassword"]):
            raise AuthenticationFailed("Текущий пароль указан неверно")

        user.set_password(serializer.validated_data["newPassword"])
        user.save(update_fields=["password"])
        audit.record(
            entity_type=AuditEntityType.USER,
            entity_id=str(user.pk),
            action="password_changed",
            actor=user,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema_view(
    list=extend_schema(summary="Пользователи", tags=["admin"]),
    create=extend_schema(summary="Завести пользователя", tags=["admin"]),
)
class UserViewSet(
    SocViewSetMixin,
    IdempotentCreateMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/users`. Только администратор `[ТЗ 4.3]`."""

    queryset = User.objects.select_related("organization", "client", "vendor")
    serializer_class = UserSerializer
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {"default": Permission.ADMIN}

    def get_queryset(self) -> QuerySet[User]:
        queryset = super().get_queryset()
        role = self.request.query_params.get("role")
        if role:
            queryset = queryset.filter(role=role)
        return queryset

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        # Форма входа отличается от формы ответа, поэтому обычный
        # ModelSerializer не подходит: разбираем вход отдельно.
        payload = UserCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        first_name, _, last_name = str(data["name"]).partition(" ")
        user = User(
            username=data["email"],
            email=data["email"],
            first_name=first_name,
            last_name=last_name,
            role=data["role"],
            locale=data["locale"],
            timezone=data["timezone"],
            organization=getattr(request.user, "organization", None),
            client=Client.objects.filter(pk=data.get("clientId")).first(),
            vendor=Vendor.objects.filter(pk=data.get("vendorId")).first(),
        )
        # Пароль не задан: вход возможен только после его установки владельцем.
        user.set_unusable_password()
        user.full_clean(exclude=["password"])
        user.save()

        audit.record(
            entity_type=AuditEntityType.USER,
            entity_id=user.pk,
            action="created",
            actor=cast(User, request.user),
            after={"role": Role(user.role).value, "email": user.email},
        )
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)
