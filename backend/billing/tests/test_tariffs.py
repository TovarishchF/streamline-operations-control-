"""Тарифы клиента и песочница `[ТЗ 3.4.1]` (`DOMAIN.md § 7.2`, `SPEC.md § 7.1`).

Приёмка M7: одна услуга у клиентов с разными тарифами даёт разные цены,
песочница объясняет, какое правило сработало и почему.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from billing.models import TariffMode, TariffRule
from core.clock import now

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Service, VendorPrice
    from counterparties.models import Client

pytestmark = pytest.mark.django_db


def tariffs_url(client: Client) -> str:
    return f"/api/v1/clients/{client.pk}/tariffs"


def rule_payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "scope": {"category": "fuel"},
        "pricing": {"mode": "cost_plus", "markupPercent": "10"},
        "validFrom": (now() - timedelta(days=10)).isoformat(),
        "validTo": (now() + timedelta(days=365)).isoformat(),
    }
    body.update(overrides)
    return body


def simulate(api: APIClient, client: Client, service: Service, **extra: Any) -> dict[str, Any]:
    response = api.post(
        f"{tariffs_url(client)}/simulate",
        {
            "serviceId": service.pk,
            "airportIcao": "UUWW",
            "onDate": (now() + timedelta(days=2)).isoformat(),
            "quantity": "1000",
            **extra,
        },
        format="json",
    )
    assert response.status_code == status.HTTP_200_OK, response.json()
    body: dict[str, Any] = response.json()
    return body


def rule(client: Client, mode: str, *, days_ago: int = 10, **values: Any) -> TariffRule:
    return TariffRule.objects.create(
        client=client,
        mode=mode,
        valid_from=now() - timedelta(days=days_ago),
        valid_to=now() + timedelta(days=365),
        **values,
    )


# ─────────────────────────── Ведение правил ───────────────────────────


def test_finance_adds_a_rule_and_it_is_listed(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    api = as_role(Role.FINANCE)
    created = api.post(
        tariffs_url(client_alpha),
        rule_payload(discount={"kind": "percent", "value": "2"}),
        format="json",
        headers={"Idempotency-Key": "tariff-000001"},
    )
    assert created.status_code == status.HTTP_201_CREATED, created.json()
    body = created.json()
    assert body["scope"] == {"category": "fuel"}
    assert body["pricing"] == {"mode": "cost_plus", "markupPercent": "10.0000"}
    assert body["discount"] == {"kind": "percent", "value": "2.0000"}

    listed = api.get(tariffs_url(client_alpha)).json()["data"]
    assert [item["id"] for item in listed] == [body["id"]]
    assert AuditEntry.objects.filter(entity_id=body["id"], action="created").exists()


@pytest.mark.parametrize(
    ("pricing", "extra"),
    [
        ({"mode": "cost_plus"}, {}),
        ({"mode": "fixed"}, {}),
        ({"mode": "pass_through"}, {"discount": {"kind": "percent", "value": "150"}}),
    ],
)
def test_inconsistent_rule_is_refused(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    pricing: dict[str, Any],
    extra: dict[str, Any],
) -> None:
    response = as_role(Role.FINANCE).post(
        tariffs_url(client_alpha),
        rule_payload(pricing=pricing, **extra),
        format="json",
        headers={"Idempotency-Key": f"tariff-bad-{pricing['mode']}"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_period_backwards_is_refused(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    response = as_role(Role.FINANCE).post(
        tariffs_url(client_alpha),
        rule_payload(validTo=(now() - timedelta(days=20)).isoformat()),
        format="json",
        headers={"Idempotency-Key": "tariff-000002"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_manager_reads_but_cannot_add(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    api = as_role(Role.MANAGER)
    assert api.get(tariffs_url(client_alpha)).status_code == status.HTTP_200_OK
    response = api.post(
        tariffs_url(client_alpha),
        rule_payload(),
        format="json",
        headers={"Idempotency-Key": "tariff-000003"},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_dispatcher_has_no_access_to_tariffs(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    assert as_role(Role.DISPATCHER).get(tariffs_url(client_alpha)).status_code == (
        status.HTTP_403_FORBIDDEN
    )


def test_adding_requires_idempotency_key(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    response = as_role(Role.FINANCE).post(tariffs_url(client_alpha), rule_payload(), format="json")
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


# ─────────────────────────── Песочница ───────────────────────────


def test_same_service_costs_differently_for_two_clients(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    client_beta: Client,
    fuel_service: Service,
    fuel_price: VendorPrice,
) -> None:
    """Приёмка M7: разные тарифы — разные цены, и видно, какое правило сработало.

    Закупка 70 × 1000 + 10 % ночной надбавки = 77 000.
    """
    markup = rule(client_alpha, TariffMode.COST_PLUS, category="fuel", markup_percent=10)
    fixed = rule(
        client_beta,
        TariffMode.FIXED,
        service=fuel_service,
        fixed_amount=Decimal(90),
        fixed_currency="RUB",
    )
    api = as_role(Role.FINANCE)

    alpha = simulate(api, client_alpha, fuel_service)
    beta = simulate(api, client_beta, fuel_service)

    assert alpha["salePrice"] == {"amount": "84700.0000", "currency": "RUB"}
    assert alpha["appliedRuleId"] == markup.pk
    assert beta["salePrice"] == {"amount": "90000.0000", "currency": "RUB"}
    assert beta["appliedRuleId"] == fixed.pk
    assert [step["step"] for step in alpha["explanation"]] == [
        "purchase",
        "cost",
        "rule",
        "markup",
        "sale",
    ]


def test_most_specific_rule_wins_and_the_reason_is_shown(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    fuel_service: Service,
    fuel_price: VendorPrice,
) -> None:
    """Услуга (3) + аэропорт (+1) сильнее категории (2) и «всего» (1)."""
    rule(client_alpha, TariffMode.COST_PLUS, markup_percent=30)
    rule(client_alpha, TariffMode.COST_PLUS, category="fuel", markup_percent=20)
    winner = rule(
        client_alpha,
        TariffMode.COST_PLUS,
        service=fuel_service,
        airport_icao="UUWW",
        markup_percent=5,
    )

    body = simulate(as_role(Role.FINANCE), client_alpha, fuel_service)

    assert body["appliedRuleId"] == winner.pk
    assert body["salePrice"]["amount"] == "80850.0000"
    priorities = [(item["priority"], item["selected"]) for item in body["candidateRules"]]
    assert priorities == [(4, True), (2, False), (1, False)]
    assert "приоритет 4" in body["candidateRules"][0]["reason"]


def test_equal_priority_prefers_the_later_rule(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    fuel_service: Service,
    fuel_price: VendorPrice,
) -> None:
    rule(client_alpha, TariffMode.COST_PLUS, category="fuel", markup_percent=10, days_ago=30)
    later = rule(client_alpha, TariffMode.PASS_THROUGH, category="fuel", days_ago=5)

    body = simulate(as_role(Role.FINANCE), client_alpha, fuel_service)

    assert body["appliedRuleId"] == later.pk
    assert body["salePrice"]["amount"] == "77000.0000"


def test_given_purchase_price_is_used_and_discount_is_explained(
    as_role: Callable[..., APIClient], client_alpha: Client, fuel_service: Service
) -> None:
    """Без цен поставщика закупка задаётся явно: 50 × 1000 + 20 % − 5 % = 57 000."""
    rule(
        client_alpha,
        TariffMode.COST_PLUS,
        category="fuel",
        markup_percent=20,
        discount_kind="percent",
        discount_value=5,
    )

    body = simulate(
        as_role(Role.FINANCE),
        client_alpha,
        fuel_service,
        purchasePrice={"amount": "50", "currency": "RUB"},
    )

    assert body["salePrice"]["amount"] == "57000.0000"
    assert body["explanation"][-2]["step"] == "discount"


def test_without_any_purchase_price_the_sandbox_says_so(
    as_role: Callable[..., APIClient], client_alpha: Client, fuel_service: Service
) -> None:
    response = as_role(Role.FINANCE).post(
        f"{tariffs_url(client_alpha)}/simulate",
        {
            "serviceId": fuel_service.pk,
            "airportIcao": "UUWW",
            "onDate": (now() + timedelta(days=2)).isoformat(),
        },
        format="json",
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert response.json()["error"]["code"] == "PRICE_NOT_FOUND"


def test_no_rule_falls_back_to_default_markup(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    fuel_service: Service,
    fuel_price: VendorPrice,
) -> None:
    body = simulate(as_role(Role.FINANCE), client_alpha, fuel_service)

    assert body["appliedRuleId"] is None
    assert body["salePrice"]["amount"] == "88550.0000"
    assert body["candidateRules"] == []
