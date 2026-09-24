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
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from accounts import registration, services
from accounts.api.serializers import (
    DemoAccountListSerializer,
    LoginSerializer,
    MeSerializer,
    PasswordChangeSerializer,
    RefreshSerializer,
    RegistrationConfirmSerializer,
    RegistrationDecisionSerializer,
    RegistrationRequestSerializer,
    RegistrationSubmitSerializer,
    TwoFactorSerializer,
    UserCreateSerializer,
    UserSerializer,
)
from accounts.models import (
    Organization,
    RegistrationKind,
    RegistrationRequest,
    RegistrationStatus,
    Role,
    User,
)
from accounts.permissions import Permission
from audit import services as audit
from audit.models import AuditEntityType
from core.api.idempotency import IdempotencyMixin, IdempotentCreateMixin
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


class RegistrationView(APIView):
    """`POST /api/v1/auth/register` `[ТЗ 4.3]` (ADR-037).

    Открытый эндпоинт: регистрируется тот, у кого учётной записи ещё нет.
    Ответ **не различает** занятый и свободный адрес почты и не сообщает,
    существует ли такой контрагент: иначе форма регистрации превращается
    в справочник клиентуры.
    """

    authentication_classes: Any = ()
    permission_classes: Any = (AllowAny,)

    @extend_schema(
        summary="Регистрация заказчика или поставщика",
        request=RegistrationSubmitSerializer,
        responses={202: dict, 400: ErrorResponseSerializer},
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        payload = RegistrationSubmitSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        organization = Organization.objects.order_by("created_at").first()
        if organization is None:
            return Response(
                {
                    "error": {
                        "code": "NOT_FOUND",
                        "message": "Организация не настроена",
                        "details": {},
                    }
                },
                status=status.HTTP_404_NOT_FOUND,
            )

        existing = RegistrationRequest.objects.filter(
            email=data["email"].lower(),
            status__in=(RegistrationStatus.EMAIL_PENDING, RegistrationStatus.PENDING),
        ).exists()
        taken = User.objects.filter(email__iexact=data["email"]).exists()

        if not existing and not taken:
            created, token = registration.submit(
                organization=organization,
                kind=data["kind"],
                contact_name=data["contactName"],
                email=data["email"],
                password=data["password"],
                phone=data["phone"],
                company_name=data["companyName"],
                legal_name=data["legalName"],
                country=data["country"],
                tax_id=data["taxId"],
                website=data["website"],
                specializations=data["specializations"],
                coverage_airports=data["coverageAirports"],
                comment=data["comment"],
            )
            registration.send_confirmation(
                request=created,
                token=token,
                base_url=request.build_absolute_uri("/").rstrip("/"),
            )

        # Ответ одинаков во всех трёх случаях: завели, адрес занят, заявка
        # уже подана. Перебор адресов через форму регистрации ничего не даёт.
        return Response(
            {"status": "email_sent", "kind": data["kind"]},
            status=status.HTTP_202_ACCEPTED,
        )


class RegistrationConfirmView(APIView):
    """`POST /api/v1/auth/register/confirm` `[ТЗ 4.3]`."""

    authentication_classes: Any = ()
    permission_classes: Any = (AllowAny,)

    @extend_schema(
        summary="Подтверждение адреса почты",
        request=RegistrationConfirmSerializer,
        responses={200: dict, 404: ErrorResponseSerializer, 409: ErrorResponseSerializer},
        tags=["auth"],
    )
    def post(self, request: Request) -> Response:
        payload = RegistrationConfirmSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        confirmed = registration.confirm_email(
            request_id=data["requestId"], token=data["token"]
        )
        return Response({"status": confirmed.status, "kind": confirmed.kind})


@extend_schema_view(
    list=extend_schema(summary="Заявки поставщиков на согласование", tags=["accounts"]),
)
class RegistrationRequestViewSet(
    IdempotencyMixin,
    SocViewSetMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,  # type: ignore[type-arg]
):
    """`/api/v1/registration-requests` `[ТЗ 4.3]`.

    Очередь руководителя: заявки заказчиков закрываются подтверждением
    почты и сюда не попадают.
    """

    serializer_class = RegistrationRequestSerializer
    # Одобрение заводит поставщика и учётную запись: повтор с тем же ключом
    # обязан вернуть первый ответ, а не завести второго поставщика.
    idempotency = "required"
    required_permissions: ClassVar[dict[str, Any]] = {
        "list": Permission.ADMIN,
        "approve": Permission.ADMIN,
        "reject": Permission.ADMIN,
    }

    def get_queryset(self) -> QuerySet[RegistrationRequest]:
        if self.action == "list":
            return cast(QuerySet[RegistrationRequest], registration.pending_for_review())

        # Решение ищется среди всех заявок поставщиков, а не только
        # ожидающих: по уже рассмотренной нужно ответить «уже рассмотрена»,
        # а не «не найдена» — второе отправит оператора искать опечатку.
        return (
            RegistrationRequest.objects.filter(kind=RegistrationKind.VENDOR)
            .select_related("decided_by")
            .order_by("created_at")
        )

    @extend_schema(
        summary="Одобрение заявки поставщика",
        request=None,
        responses={200: RegistrationRequestSerializer, 409: ErrorResponseSerializer},
        tags=["accounts"],
    )
    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        target = self.get_object()

        def produce() -> Response:
            approved = registration.approve(request=target, actor=cast(User, request.user))
            return Response(RegistrationRequestSerializer(approved).data)

        return self.idempotent(request, produce)

    @extend_schema(
        summary="Отклонение заявки поставщика",
        request=RegistrationDecisionSerializer,
        responses={200: RegistrationRequestSerializer, 409: ErrorResponseSerializer},
        tags=["accounts"],
    )
    @action(detail=True, methods=["post"])
    def reject(self, request: Request, pk: str | None = None) -> Response:
        target = self.get_object()

        def produce() -> Response:
            payload = RegistrationDecisionSerializer(data=request.data)
            payload.is_valid(raise_exception=True)

            rejected = registration.reject(
                request=target,
                actor=cast(User, request.user),
                reason=payload.validated_data["reason"],
            )
            return Response(RegistrationRequestSerializer(rejected).data)

        return self.idempotent(request, produce)
