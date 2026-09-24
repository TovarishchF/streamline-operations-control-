"""Регистрация заказчиков и поставщиков `[ТЗ 4.3]` (ADR-037).

Проверяется то, из-за чего открытая форма регистрации опасна:

* что она не выдаёт доступ до подтверждения адреса;
* что поставщик не попадает в систему без решения человека;
* что по ответу нельзя перебрать чужие адреса;
* что пароль не лежит в базе открытым и не попадает в ответы.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import RegistrationRequest, RegistrationStatus, Role, User

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

URL = "/api/v1/auth/register"
CONFIRM_URL = "/api/v1/auth/register/confirm"
QUEUE_URL = "/api/v1/registration-requests"

PASSWORD = "Registracia-Parol-2026"


def idempotent(key: str = "reg-key-00000001") -> dict[str, str]:
    """Решение по заявке заводит записи: ключ обязателен (ADR-018)."""
    return {"Idempotency-Key": key}


def client_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": "client",
        "contactName": "Мария Львовна Соболева",
        "email": "soboleva@example-charter.test",
        "password": PASSWORD,
        "companyName": "Чартер Восток",
        "country": "RU",
    }
    payload.update(overrides)
    return payload


def vendor_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": "vendor",
        "contactName": "Пётр Сергеевич Лавров",
        "email": "lavrov@example-handling.test",
        "password": PASSWORD,
        "companyName": "Хандлинг Северо-Запад",
        "taxId": "7801234567",
        "specializations": ["handling", "deicing"],
        "coverageAirports": ["ulli", "UUEE"],
    }
    payload.update(overrides)
    return payload


def token_from_outbox(request: RegistrationRequest) -> str:
    """Токен достаётся из письма — так же, как его достанет заявитель."""
    from comms.models import OutboxMessage

    message = OutboxMessage.objects.filter(related_entity_id=request.pk).first()
    assert message is not None, "письмо подтверждения не поставлено в очередь"
    found = re.search(r"token=([A-Za-z0-9_-]+)", message.body)
    assert found is not None, "в письме нет ссылки подтверждения"
    return found.group(1)


def submit(api: APIClient, payload: dict[str, Any]) -> RegistrationRequest:
    response = api.post(URL, payload, format="json")
    assert response.status_code == status.HTTP_202_ACCEPTED, response.data
    found = RegistrationRequest.objects.filter(email=payload["email"].lower()).first()
    assert found is not None
    return found


# ─────────────────────────── Подача ───────────────────────────


def test_registration_is_open_without_a_token(api: APIClient, organization: Any) -> None:
    """Регистрируется тот, у кого учётной записи ещё нет."""
    api.credentials()
    assert api.post(URL, client_payload(), format="json").status_code == (
        status.HTTP_202_ACCEPTED
    )


def test_no_account_before_the_email_is_confirmed(
    api: APIClient, organization: Any
) -> None:
    request = submit(api, client_payload())

    assert request.status == RegistrationStatus.EMAIL_PENDING
    assert request.created_user is None
    assert not User.objects.filter(email="soboleva@example-charter.test").exists()


def test_password_is_stored_hashed(api: APIClient, organization: Any) -> None:
    """Заявка лежит в очереди днями: открытый пароль в базе недопустим."""
    request = submit(api, vendor_payload())

    assert request.password_hash != PASSWORD
    assert PASSWORD not in request.password_hash


def test_response_does_not_reveal_a_taken_address(
    api: APIClient, organization: Any, dispatcher: User
) -> None:
    """Иначе форма регистрации превращается в справочник клиентуры."""
    dispatcher.email = "zanyato@example.test"
    dispatcher.save(update_fields=["email"])

    free = api.post(URL, client_payload(email="svobodno@example.test"), format="json")
    taken = api.post(URL, client_payload(email="zanyato@example.test"), format="json")

    assert free.status_code == taken.status_code
    assert free.json() == taken.json()
    # И записи по занятому адресу не появилось.
    assert not RegistrationRequest.objects.filter(email="zanyato@example.test").exists()


def test_weak_password_is_refused(api: APIClient, organization: Any) -> None:
    response = api.post(URL, client_payload(password="12345678"), format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_vendor_without_categories_is_refused(api: APIClient, organization: Any) -> None:
    """Поставщик без категорий непонятно чем занимается."""
    response = api.post(URL, vendor_payload(specializations=[]), format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_second_submission_creates_no_duplicate(api: APIClient, organization: Any) -> None:
    submit(api, vendor_payload())
    api.post(URL, vendor_payload(), format="json")

    assert RegistrationRequest.objects.filter(email=vendor_payload()["email"]).count() == 1


# ─────────────────────────── Подтверждение почты ───────────────────────────


def test_client_gets_access_right_after_confirming(
    api: APIClient, organization: Any
) -> None:
    """Заказчику согласование не нужно: чужих данных он не видит."""
    request = submit(api, client_payload())
    token = token_from_outbox(request)

    response = api.post(
        CONFIRM_URL, {"requestId": request.pk, "token": token}, format="json"
    )
    assert response.status_code == status.HTTP_200_OK

    request.refresh_from_db()
    assert request.status == RegistrationStatus.APPROVED
    assert request.created_user is not None
    assert request.created_user.role == Role.CLIENT
    assert request.created_client is not None
    assert request.created_user.client_id == request.created_client.pk


def test_vendor_waits_for_a_decision(api: APIClient, organization: Any) -> None:
    """Взять поставщика в работу — решение о закупке, а не о доступе."""
    request = submit(api, vendor_payload())

    api.post(CONFIRM_URL, {"requestId": request.pk, "token": token_from_outbox(request)},
             format="json")

    request.refresh_from_db()
    assert request.status == RegistrationStatus.PENDING
    assert request.created_user is None


def test_wrong_token_confirms_nothing(api: APIClient, organization: Any) -> None:
    request = submit(api, client_payload())

    response = api.post(
        CONFIRM_URL, {"requestId": request.pk, "token": "postoronniy-token"}, format="json"
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    request.refresh_from_db()
    assert request.email_confirmed_at is None


def test_the_link_works_once(api: APIClient, organization: Any) -> None:
    """Ссылка из письма — одноразовый пароль, и хранится хэшем."""
    request = submit(api, vendor_payload())
    token_from_outbox(request)

    api.post(CONFIRM_URL, {"requestId": request.pk, "token": token_from_outbox(request)},
             format="json")

    request.refresh_from_db()
    assert request.email_token_hash == ""


def test_opening_the_link_twice_is_not_an_error(api: APIClient, organization: Any) -> None:
    """Письмо могли открыть дважды: второй раз ничего не меняет."""
    request = submit(api, vendor_payload())
    token = token_from_outbox(request)

    first = api.post(CONFIRM_URL, {"requestId": request.pk, "token": token}, format="json")
    second = api.post(CONFIRM_URL, {"requestId": request.pk, "token": token}, format="json")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK


# ─────────────────────────── Очередь и решение ───────────────────────────


def confirmed_vendor(api: APIClient) -> RegistrationRequest:
    request = submit(api, vendor_payload())
    api.post(CONFIRM_URL, {"requestId": request.pk, "token": token_from_outbox(request)},
             format="json")
    request.refresh_from_db()
    return request


def test_queue_holds_only_vendors(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    """Заявки заказчиков закрываются подтверждением и в очереди не лежат."""
    confirmed_vendor(api)
    client_request = submit(api, client_payload())
    api.post(
        CONFIRM_URL,
        {"requestId": client_request.pk, "token": token_from_outbox(client_request)},
        format="json",
    )

    rows = as_role(Role.ADMIN).get(QUEUE_URL).json()["data"]
    assert [row["kind"] for row in rows] == ["vendor"]


def test_approval_creates_the_vendor_and_the_account(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    request = confirmed_vendor(api)

    response = as_role(Role.ADMIN).post(
        f"{QUEUE_URL}/{request.pk}/approve", format="json", headers=idempotent()
    )
    assert response.status_code == status.HTTP_200_OK

    request.refresh_from_db()
    assert request.created_vendor is not None
    # Коды аэропортов приведены к верхнему регистру при подаче.
    assert request.created_vendor.coverage_airports == ["ULLI", "UUEE"]
    assert request.created_user is not None
    assert request.created_user.role == Role.VENDOR
    # Пароль задан заявителем и работает без пересылки по почте.
    assert request.created_user.check_password(PASSWORD)
    # В заявке хэша больше нет: он переехал в учётную запись.
    assert request.password_hash == ""


def test_rejection_creates_nothing(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    request = confirmed_vendor(api)

    response = as_role(Role.ADMIN).post(
        f"{QUEUE_URL}/{request.pk}/reject",
        {"reason": "Нет лицензии"},
        format="json",
        headers=idempotent(),
    )

    assert response.status_code == status.HTTP_200_OK
    request.refresh_from_db()
    assert request.status == RegistrationStatus.REJECTED
    assert request.created_user is None
    assert request.created_vendor is None
    assert request.decision_reason == "Нет лицензии"


def test_second_decision_is_refused(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    request = confirmed_vendor(api)
    admin = as_role(Role.ADMIN)

    admin.post(f"{QUEUE_URL}/{request.pk}/approve", format="json", headers=idempotent("reg-a-0001"))
    again = admin.post(
        f"{QUEUE_URL}/{request.pk}/reject",
        {"reason": "Передумали"},
        format="json",
        headers=idempotent("reg-a-0002"),
    )

    assert again.status_code == status.HTTP_409_CONFLICT


def test_dispatcher_cannot_decide(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    """Взять поставщика в работу — не диспетчерское решение."""
    request = confirmed_vendor(api)

    response = as_role(Role.DISPATCHER).post(
        f"{QUEUE_URL}/{request.pk}/approve", format="json", headers=idempotent()
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_queue_is_closed_to_the_vendor_portal(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any, vendor_alpha: Any
) -> None:
    """Очередь заявок — не то, что показывают поставщику."""
    confirmed_vendor(api)

    response = as_role(Role.VENDOR, vendor=vendor_alpha).get(QUEUE_URL)
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_queue_never_carries_a_password(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    confirmed_vendor(api)

    body = as_role(Role.ADMIN).get(QUEUE_URL).content.decode("utf-8")
    assert PASSWORD not in body
    assert "password" not in body.lower()


def test_repeat_with_the_same_key_creates_one_vendor(
    as_role: Callable[..., APIClient], api: APIClient, organization: Any
) -> None:
    """ADR-018: повтор возвращает первый ответ, а не заводит второго."""
    from counterparties.models import Vendor

    request = confirmed_vendor(api)
    admin = as_role(Role.ADMIN)
    before = Vendor.objects.count()

    first = admin.post(f"{QUEUE_URL}/{request.pk}/approve", format="json", headers=idempotent())
    second = admin.post(f"{QUEUE_URL}/{request.pk}/approve", format="json", headers=idempotent())

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert second.json() == first.json()
    assert Vendor.objects.count() == before + 1
