"""Заведение клиентов, поставщиков и договоров `[ТЗ 3.3]`.

Проверяется то, ради чего эндпоинты и написаны: кнопка «Добавить клиента»
создаёт запись, которая видна в реестре; договор с истекающей датой
попадает в жёлтую зону светофора; чужие права не пускают.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntityType, AuditEntry
from core.clock import now
from counterparties.models import Client, ContractStatus, Vendor, VendorContract

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

CLIENTS_URL = "/api/v1/clients"
VENDORS_URL = "/api/v1/vendors"
CONTRACTS_URL = "/api/v1/contracts"


def idempotent(key: str = "test-key-00000001") -> dict[str, str]:
    """Заголовок идемпотентности. Все создающие эндпоинты требуют его (ADR-018)."""
    return {"Idempotency-Key": key}


def client_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Авиакомпания Ясный Берег",
        "legalName": "ООО «Ясный Берег»",
        "country": "ru",
        "settlementCurrency": "RUB",
        "paymentTerms": {"mode": "deferred", "deferDays": 30},
        "contacts": [
            {
                "name": "Ирина Полякова",
                "role": "Финансовый директор",
                "email": "finance@yasnyi-bereg.test",
                "locale": "ru",
                "isPrimary": True,
            }
        ],
    }
    payload.update(overrides)
    return payload


# ─────────────────────────── Клиенты ───────────────────────────


def test_finance_creates_client_and_sees_it_in_registry(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.FINANCE)

    created = api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent())
    assert created.status_code == status.HTTP_201_CREATED, created.data

    body = created.json()
    assert body["name"] == "Авиакомпания Ясный Берег"
    assert body["paymentTerms"] == {"mode": "deferred", "deferDays": 30}
    assert body["contacts"][0]["email"] == "finance@yasnyi-bereg.test"
    # Запись введена человеком, а не сгенерирована (`CLAUDE.md § 4`)
    assert body["dataSource"] == "user"
    assert body["isDemo"] is False

    listed = api.get(CLIENTS_URL)
    assert [row["id"] for row in listed.json()["data"]] == [body["id"]]


def test_client_creation_is_written_to_audit(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.FINANCE)
    created = api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent())

    entry = AuditEntry.objects.get(
        entity_type=AuditEntityType.CLIENT, entity_id=created.json()["id"]
    )
    assert entry.action == "created"
    assert entry.after is not None
    assert entry.after["name"] == "Авиакомпания Ясный Берег"


def test_dispatcher_cannot_create_client(as_role: Callable[..., APIClient]) -> None:
    """Диспетчер читает реестр клиентов, но не правит его (`SPEC.md § 2.2`)."""
    api = as_role(Role.DISPATCHER)
    response = api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent())
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_client_without_idempotency_key_is_rejected(
    as_role: Callable[..., APIClient],
) -> None:
    """Повтор запроса на плохой связи не должен заводить второго клиента."""
    api = as_role(Role.FINANCE)
    response = api.post(CLIENTS_URL, client_payload(), format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_repeated_key_returns_first_result_without_duplicate(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.FINANCE)
    first = api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent())
    second = api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent())

    assert second.status_code == status.HTTP_201_CREATED
    assert second.json()["id"] == first.json()["id"]
    assert Client.objects.count() == 1


def test_duplicate_client_name_is_rejected(as_role: Callable[..., APIClient]) -> None:
    """Тёзки среди клиентов — источник ошибочно выставленных счетов."""
    api = as_role(Role.FINANCE)
    api.post(CLIENTS_URL, client_payload(), format="json", headers=idempotent("key-first-0001"))
    response = api.post(
        CLIENTS_URL, client_payload(), format="json", headers=idempotent("key-second-002")
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_deferred_terms_without_days_are_rejected(
    as_role: Callable[..., APIClient],
) -> None:
    """Отсрочка в ноль дней — это постоплата, названная другим словом."""
    api = as_role(Role.FINANCE)
    response = api.post(
        CLIENTS_URL,
        client_payload(paymentTerms={"mode": "deferred", "deferDays": 0}),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_credit_limit_round_trips_as_decimal_string(
    as_role: Callable[..., APIClient],
) -> None:
    """Деньги ходят строкой с четырьмя знаками (`CLAUDE.md § 3` п. 1)."""
    api = as_role(Role.FINANCE)
    response = api.post(
        CLIENTS_URL,
        client_payload(creditLimit={"amount": "1500000.0000", "currency": "RUB"}),
        format="json",
        headers=idempotent(),
    )
    assert response.json()["creditLimit"] == {
        "amount": "1500000.0000",
        "currency": "RUB",
    }


def test_unsupported_currency_is_rejected(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        CLIENTS_URL,
        client_payload(settlementCurrency="GBP"),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


# ─────────────────────────── Поставщики ───────────────────────────


def vendor_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Наземные Службы Приполярья",
        "legalName": "ООО «Наземные Службы Приполярья»",
        "country": "ru",
        "settlementCurrency": "RUB",
        "specializations": ["handling", "catering"],
        "coverage": {"airports": ["ulli", "uuee"], "regions": ["Северо-Запад"]},
        "paymentTerms": {"mode": "deferred", "deferDays": 14},
        "manualQualityScore": 4,
        "certificates": [
            {
                "kind": "IATA",
                "number": "IGOM-2026-114",
                "validFrom": "2026-01-01T00:00:00Z",
                "validTo": "2027-01-01T00:00:00Z",
            }
        ],
    }
    payload.update(overrides)
    return payload


def test_vendor_is_created_with_coverage_normalised(
    as_role: Callable[..., APIClient],
) -> None:
    """Коды ИКАО приводятся к верхнему регистру: подбор ищет по точному коду.

    Заводит поставщика администратор: по матрице `SPEC.md § 2.2` право
    `vendor.edit` выдано только ему, финансист реестр только читает.
    """
    api = as_role(Role.ADMIN)
    response = api.post(VENDORS_URL, vendor_payload(), format="json", headers=idempotent())

    assert response.status_code == status.HTTP_201_CREATED, response.data
    body = response.json()
    assert body["coverage"]["airports"] == ["ULLI", "UUEE"]
    assert body["certificates"][0]["number"] == "IGOM-2026-114"
    assert body["manualQualityScore"] == 4


def test_vendors_filter_by_airport_coverage(
    as_role: Callable[..., APIClient],
) -> None:
    api = as_role(Role.ADMIN)
    api.post(VENDORS_URL, vendor_payload(), format="json", headers=idempotent("key-vendor-001"))

    assert len(api.get(f"{VENDORS_URL}?airportIcao=ULLI").json()["data"]) == 1
    assert api.get(f"{VENDORS_URL}?airportIcao=UUDD").json()["data"] == []


# ─────────────────────────── Договоры ───────────────────────────


def contract_payload(vendor: Vendor, **overrides: Any) -> dict[str, Any]:
    start = now() - timedelta(days=30)
    payload: dict[str, Any] = {
        "vendorId": vendor.pk,
        "number": "ДГ-2026-0417",
        "validFrom": start.isoformat(),
        "validTo": (start + timedelta(days=365)).isoformat(),
        "currency": "RUB",
        "paymentTerms": {"mode": "deferred", "deferDays": 14},
    }
    payload.update(overrides)
    return payload


def test_finance_cannot_create_vendor(as_role: Callable[..., APIClient]) -> None:
    """Финансист видит реестр поставщиков, но не заводит их (`SPEC.md § 2.2`)."""
    api = as_role(Role.FINANCE)
    response = api.post(VENDORS_URL, vendor_payload(), format="json", headers=idempotent())
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_contract_is_created_and_listed(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    created = api.post(
        CONTRACTS_URL, contract_payload(vendor_alpha), format="json", headers=idempotent()
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    body = created.json()
    assert body["number"] == "ДГ-2026-0417"
    assert body["status"] == ContractStatus.ACTIVE
    # Вложений не прикладывали — список пуст, а не отсутствует
    assert body["attachments"] == []

    listed = api.get(f"{CONTRACTS_URL}?vendorId={vendor_alpha.pk}")
    assert len(listed.json()["data"]) == 1


def test_contract_expiring_within_30_days_shows_warning_status(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    """Светофор сроков вычисляется от дат, а не хранится (G-42)."""
    api = as_role(Role.FINANCE)
    created = api.post(
        CONTRACTS_URL,
        contract_payload(
            vendor_alpha,
            validFrom=(now() - timedelta(days=300)).isoformat(),
            validTo=(now() + timedelta(days=10)).isoformat(),
        ),
        format="json",
        headers=idempotent(),
    )
    assert created.json()["status"] == ContractStatus.EXPIRING


def test_expired_contract_is_reported_as_expired(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    contract = VendorContract.objects.create(
        vendor=vendor_alpha,
        number="ДГ-2025-0001",
        valid_from=now() - timedelta(days=400),
        valid_to=now() - timedelta(days=5),
        currency="RUB",
    )
    assert contract.status == ContractStatus.EXPIRED

    api = as_role(Role.FINANCE)
    rows = api.get(f"{CONTRACTS_URL}?status=expired").json()["data"]
    assert [row["id"] for row in rows] == [contract.pk]


def test_duplicate_contract_number_per_vendor_is_rejected(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    body = contract_payload(vendor_alpha)
    api.post(CONTRACTS_URL, body, format="json", headers=idempotent("k-1-000001"))
    response = api.post(CONTRACTS_URL, body, format="json", headers=idempotent("k-2-000002"))
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_contract_end_before_start_is_rejected(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        CONTRACTS_URL,
        contract_payload(
            vendor_alpha,
            validFrom=now().isoformat(),
            validTo=(now() - timedelta(days=1)).isoformat(),
        ),
        format="json",
        headers=idempotent(),
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_dispatcher_reads_contracts_but_cannot_create(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    api = as_role(Role.DISPATCHER)
    assert api.get(CONTRACTS_URL).status_code == status.HTTP_200_OK
    assert (
        api.post(
            CONTRACTS_URL, contract_payload(vendor_alpha), format="json", headers=idempotent()
        ).status_code
        == status.HTTP_403_FORBIDDEN
    )
