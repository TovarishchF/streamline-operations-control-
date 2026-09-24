"""Регистрация заказчиков и поставщиков `[ТЗ 4.3]` (ADR-037).

Две разные вещи под одним словом «регистрация».

**Заказчик** регистрируется сам. После подтверждения почты появляются
карточка заказчика и учётная запись; человека в этом сценарии нет. Риска
это не создаёт: новый заказчик видит только собственные рейсы, а их
у только что заведённой карточки нет вовсе — изоляция обеспечена фильтром
по арендатору на сервере (`BACKEND.md § 3.7`), а не тем, кто завёл запись.

**Поставщик** так не может. Взять поставщика в работу — решение о закупке:
кому мы доверим заправку борта и с кем будем судиться при срыве. Его
заявка уходит руководителю, и учётная запись появляется только после
одобрения.

Почта подтверждается до рассмотрения в обоих случаях: разбирать заявки
с несуществующих адресов — работа впустую, ответить по ним всё равно
некуда.
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any

from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction

from accounts.models import (
    Organization,
    RegistrationKind,
    RegistrationRequest,
    RegistrationStatus,
    Role,
    User,
)
from audit import services as audit
from audit.models import AuditEntityType
from core.clock import now
from core.exceptions import DomainError

if TYPE_CHECKING:
    from counterparties.models import Client, Vendor


class RegistrationClosed(DomainError):
    """Заявка уже рассмотрена: второе решение ничего не меняет."""

    code = "REGISTRATION_CLOSED"
    http_status = 409


class EmailNotConfirmed(DomainError):
    """Рассматривать заявку с неподтверждённого адреса нечего."""

    code = "EMAIL_NOT_CONFIRMED"
    http_status = 409


class RegistrationNotFound(DomainError):
    code = "NOT_FOUND"
    http_status = 404


def _unique_username(email: str) -> str:
    """Логин из адреса почты, с суффиксом при совпадении.

    Адрес уникален среди открытых заявок, но пользователь с таким логином
    мог быть заведён администратором вручную.
    """
    base = email.split("@")[0][:120] or "user"
    username = base
    suffix = 2
    while User.objects.filter(username=username).exists():
        username = f"{base}{suffix}"
        suffix += 1
    return username


def submit(
    *,
    organization: Organization,
    kind: str,
    contact_name: str,
    email: str,
    password: str,
    company_name: str,
    phone: str = "",
    legal_name: str = "",
    country: str = "",
    tax_id: str = "",
    website: str = "",
    specializations: list[str] | None = None,
    coverage_airports: list[str] | None = None,
    comment: str = "",
) -> tuple[RegistrationRequest, str]:
    """Заводит заявку и возвращает её вместе с токеном подтверждения.

    Токен возвращается **один раз** — он уходит в письмо. В базе лежит
    только хэш: ссылка из письма это одноразовый пароль, и хранить её
    в открытом виде нельзя.
    """
    token = secrets.token_urlsafe(32)

    request = RegistrationRequest.objects.create(
        organization=organization,
        kind=kind,
        status=RegistrationStatus.EMAIL_PENDING,
        contact_name=contact_name.strip(),
        email=email.strip().lower(),
        phone=phone.strip(),
        # Заявка может пролежать в очереди неделю, и всё это время пароль
        # в открытом виде лежал бы в базе.
        password_hash=make_password(password),
        company_name=company_name.strip(),
        legal_name=legal_name.strip(),
        country=country.strip().upper(),
        tax_id=tax_id.strip(),
        website=website.strip(),
        specializations=specializations or [],
        coverage_airports=[code.strip().upper() for code in (coverage_airports or [])],
        comment=comment.strip(),
        email_token_hash=make_password(token),
    )

    audit.record(
        entity_type=AuditEntityType.USER,
        entity_id=request.pk,
        action="registration_submitted",
        actor=None,
        after={"kind": kind, "company": request.company_name},
    )
    return request, token


def send_confirmation(*, request: RegistrationRequest, token: str, base_url: str) -> None:
    """Кладёт письмо подтверждения в исходящие.

    Доставка идёт через ту же очередь и тот же адаптер, что и остальная
    переписка: в режиме заглушки письмо складывается в `.eml` и видно
    в разделе «Исходящие», а наружу не уходит. Это не имитация отправки —
    раздел интеграций показывает фактический режим подключения
    (`CLAUDE.md § 4`).
    """
    from comms.services import outbox

    link = f"{base_url.rstrip('/')}/register/confirm?id={request.pk}&token={token}"
    tail = (
        "После подтверждения доступ откроется сразу."
        if request.kind == RegistrationKind.CLIENT
        else "После подтверждения заявка уйдёт на согласование."
    )
    body = (
        f"{request.contact_name}, здравствуйте.\n\n"
        f"Заявка на регистрацию «{request.company_name}» принята. "
        "Чтобы подтвердить адрес, откройте ссылку:\n\n"
        f"{link}\n\n"
        f"{tail}"
    )
    outbox.enqueue(
        channel="email",
        to=[{"email": request.email, "name": request.contact_name}],
        subject="Подтверждение адреса · SOC",
        body=body,
        related=("registration", request.pk),
    )


def confirm_email(*, request_id: str, token: str) -> RegistrationRequest:
    """Подтверждает адрес и, для заказчика, сразу выдаёт доступ."""
    request = RegistrationRequest.objects.filter(pk=request_id).first()
    if request is None:
        raise RegistrationNotFound("Заявка не найдена")

    if request.email_confirmed_at is not None:
        # Повторный переход по той же ссылке — не ошибка: письмо могли
        # открыть дважды. Второй раз ничего не меняет.
        return request

    if request.status != RegistrationStatus.EMAIL_PENDING:
        raise RegistrationClosed("Заявка уже рассмотрена")

    if not check_password(token, request.email_token_hash):
        raise RegistrationNotFound("Ссылка подтверждения недействительна")

    with transaction.atomic():
        request.email_confirmed_at = now()
        # Ссылка одноразовая: после перехода хэш стирается.
        request.email_token_hash = ""
        request.status = RegistrationStatus.PENDING
        request.save(
            update_fields=["email_confirmed_at", "email_token_hash", "status", "updated_at"]
        )

        audit.record(
            entity_type=AuditEntityType.USER,
            entity_id=request.pk,
            action="registration_email_confirmed",
            actor=None,
        )

        if request.kind == RegistrationKind.CLIENT:
            # Заказчику согласование не нужно: доступа к чужим данным
            # у него нет, а своих ещё нет.
            return approve(request=request, actor=None)

    return request


@transaction.atomic
def approve(*, request: RegistrationRequest, actor: User | None) -> RegistrationRequest:
    """Заводит карточку контрагента и учётную запись."""
    if request.status not in (RegistrationStatus.PENDING,):
        raise RegistrationClosed("Заявка уже рассмотрена")
    if request.email_confirmed_at is None:
        raise EmailNotConfirmed("Адрес почты не подтверждён")

    client: Client | None = None
    vendor: Vendor | None = None

    if request.kind == RegistrationKind.CLIENT:
        from counterparties.models import Client as ClientModel

        client = ClientModel.objects.create(
            organization=request.organization,
            name=request.company_name,
            legal_name=request.legal_name,
            country=request.country,
        )
        role = Role.CLIENT
    else:
        from counterparties.models import Vendor as VendorModel

        vendor = VendorModel.objects.create(
            organization=request.organization,
            name=request.company_name,
            legal_name=request.legal_name,
            country=request.country,
            specializations=request.specializations,
            coverage_airports=request.coverage_airports,
        )
        role = Role.VENDOR

    user = User.objects.create(
        username=_unique_username(request.email),
        email=request.email,
        role=role,
        organization=request.organization,
        client=client,
        vendor=vendor,
        is_active=True,
    )
    # Пароль задан заявителем при подаче и с тех пор лежит хэшем:
    # заново его не спрашиваем и по почте не отправляем.
    user.password = request.password_hash
    user.save(update_fields=["password"])

    request.status = RegistrationStatus.APPROVED
    request.decided_at = now()
    request.decided_by = actor
    request.created_user = user
    request.created_client = client
    request.created_vendor = vendor
    # Хэш пароля переехал в учётную запись: в заявке он больше не нужен.
    request.password_hash = ""
    request.save()

    audit.record(
        entity_type=AuditEntityType.USER,
        entity_id=request.pk,
        action="registration_approved",
        actor=actor,
        after={"kind": request.kind, "userId": user.pk},
    )
    return request


@transaction.atomic
def reject(*, request: RegistrationRequest, actor: User, reason: str) -> RegistrationRequest:
    """Отказ. Причина обязательна: заявителю её сообщают."""
    if request.status != RegistrationStatus.PENDING:
        raise RegistrationClosed("Заявка уже рассмотрена")

    request.status = RegistrationStatus.REJECTED
    request.decided_at = now()
    request.decided_by = actor
    request.decision_reason = reason
    # Учётной записи не будет — хранить хэш пароля незачем.
    request.password_hash = ""
    request.save()

    audit.record(
        entity_type=AuditEntityType.USER,
        entity_id=request.pk,
        action="registration_rejected",
        actor=actor,
        after={"reason": reason},
    )
    return request


def pending_for_review() -> Any:
    """Очередь на согласование: только поставщики.

    Заявки заказчиков закрываются подтверждением почты и в очереди
    не задерживаются.
    """
    return (
        RegistrationRequest.objects.filter(
            status=RegistrationStatus.PENDING, kind=RegistrationKind.VENDOR
        )
        .select_related("decided_by")
        .order_by("created_at")
    )
