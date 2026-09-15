"""Построение отчётов `[ТЗ 3.6.1]` (`SPEC.md § 9.1`).

Проверяется то, из-за чего отчёту перестают верить:

* маржа сходится с выручкой и закупкой, а итог — с колонкой на экране
  (ADR-002 п. 3);
* отсутствие данных выглядит как отсутствие данных, а не как ноль
  (`CLAUDE.md § 4`);
* финансовые сведения не показываются тем, кому не положены
  (`SPEC.md § 2.2`).
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from reports import definitions
from reports.services import builders

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from billing.models import Invoice
    from catalog.models import Service
    from counterparties.models import Client, Vendor
    from flights.models import Flight
    from orders.models import ServiceOrder

pytestmark = pytest.mark.django_db

REPORTS_URL = "/api/v1/reports"


# ─────────────────────────── Каталог ───────────────────────────


def test_catalog_lists_every_report_from_the_statement(
    as_role: Callable[..., APIClient],
) -> None:
    """Семь отчётов `[ТЗ 3.6.1]`, не больше и не меньше."""
    api = as_role(Role.MANAGER)
    response = api.get(REPORTS_URL)

    assert response.status_code == status.HTTP_200_OK, response.data
    codes = {item["code"] for item in response.json()["data"]}
    assert codes == set(definitions.DEFINITIONS)
    assert len(codes) == 7


def test_catalog_declares_parameters_of_each_report(
    as_role: Callable[..., APIClient],
) -> None:
    """По каталогу строится форма отбора, значит параметры обязаны быть в нём."""
    api = as_role(Role.MANAGER)
    catalog = {item["code"]: item for item in api.get(REPORTS_URL).json()["data"]}

    financial = catalog[definitions.FINANCIAL]
    keys = {parameter["key"] for parameter in financial["parameters"]}
    assert {"from", "to", "clientId"} == keys
    assert all(
        parameter["required"]
        for parameter in financial["parameters"]
        if parameter["key"] in ("from", "to")
    )


# ─────────────────────────── Рейсы за период ───────────────────────────


def test_flights_period_counts_services_of_the_flight(
    as_role: Callable[..., APIClient],
    flight: Flight,
    completed_order: ServiceOrder,
    query: dict[str, str],
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.get(f"{REPORTS_URL}/{definitions.FLIGHTS_PERIOD}", query)

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["code"] == definitions.FLIGHTS_PERIOD

    rows = {row["number"]: row for row in body["rows"]}
    assert flight.number in rows
    row = rows[flight.number]
    assert row["route"] == "UUWW → ULLI"
    assert row["services"] == 1
    assert body["totals"]["services"] == 1


def test_flight_outside_the_period_is_not_shown(
    as_role: Callable[..., APIClient], flight: Flight, empty_period: dict[str, Any]
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.get(
        f"{REPORTS_URL}/{definitions.FLIGHTS_PERIOD}",
        {"from": empty_period["from"].isoformat(), "to": empty_period["to"].isoformat()},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["rows"] == []


# ─────────────────────────── Оказанные услуги ───────────────────────────


def test_services_rendered_shows_actual_quantity_and_purchase_cost(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    vendor_alpha: Vendor,
    query: dict[str, str],
) -> None:
    """Оказано — значит по факту, а не по плану (ADR-020)."""
    api = as_role(Role.DISPATCHER)
    rows = api.get(f"{REPORTS_URL}/{definitions.SERVICES_RENDERED}", query).json()["rows"]

    assert len(rows) == 1
    row = rows[0]
    assert row["vendor"] == vendor_alpha.name
    assert row["airport"] == "UUWW"
    assert row["count"] == 1
    assert Decimal(row["quantity"]) == completed_order.actual_quantity
    assert Decimal(row["cost"]) == completed_order.purchase_cost_amount
    assert row["currency"] == "RUB"


def test_only_completed_orders_are_counted_as_rendered(
    as_role: Callable[..., APIClient],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: Any,
    query: dict[str, str],
) -> None:
    """Заказанная, но не выполненная услуга оказанной не считается."""
    from orders.services import orders as order_services

    order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal("500.0000"),
        vendor=vendor_alpha,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )

    api = as_role(Role.DISPATCHER)
    rows = api.get(f"{REPORTS_URL}/{definitions.SERVICES_RENDERED}", query).json()["rows"]
    assert rows == []


# ─────────────────────────── Финансовый ───────────────────────────


def test_financial_margin_is_revenue_minus_cost(
    as_role: Callable[..., APIClient],
    flight: Flight,
    completed_order: ServiceOrder,
    issued_invoice: Invoice,
    query: dict[str, str],
) -> None:
    """`DOMAIN.md § 7.3`: маржа считается, а не пересказывается."""
    api = as_role(Role.FINANCE)
    body = api.get(f"{REPORTS_URL}/{definitions.FINANCIAL}", query).json()

    rows = {row["flight"]: row for row in body["rows"]}
    row = rows[flight.number]

    revenue = Decimal(row["revenue"])
    cost = Decimal(row["cost"])
    assert revenue == issued_invoice.total_amount.quantize(Decimal("0.01"))
    assert cost == completed_order.purchase_cost_amount
    assert Decimal(row["margin"]) == revenue - cost
    assert Decimal(row["marginPercent"]) == (
        (revenue - cost) / revenue * 100
    ).quantize(Decimal("0.01"))


def test_financial_totals_equal_sum_of_rows(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    issued_invoice: Invoice,
    query: dict[str, str],
) -> None:
    """Итог обязан сходиться с колонкой (ADR-002 п. 3)."""
    api = as_role(Role.FINANCE)
    body = api.get(f"{REPORTS_URL}/{definitions.FINANCIAL}", query).json()

    for key in ("revenue", "cost", "margin"):
        column_sum = sum(
            (Decimal(row[key]) for row in body["rows"] if row[key] is not None), Decimal(0)
        )
        assert Decimal(body["totals"][key]) == column_sum, key


def test_draft_invoice_is_not_revenue(
    as_role: Callable[..., APIClient],
    flight: Flight,
    completed_order: ServiceOrder,
    make_user: Callable[..., Any],
    query: dict[str, str],
) -> None:
    """Выручка — то, что выставлено клиенту, а не то, что подготовлено."""
    from billing.services import documents

    documents.build_invoice(
        flight=flight, quote=None, actor=make_user(Role.FINANCE, suffix="draft")
    )

    api = as_role(Role.FINANCE)
    rows = api.get(f"{REPORTS_URL}/{definitions.FINANCIAL}", query).json()["rows"]
    row = next(item for item in rows if item["flight"] == flight.number)

    assert Decimal(row["revenue"]) == Decimal(0)
    # Расход есть, выручки нет — маржа отрицательная и не обнуляется
    assert Decimal(row["margin"]) < 0
    # Процент от нулевой выручки не считается вовсе
    assert row["marginPercent"] is None


def test_percent_of_nothing_is_not_zero() -> None:
    """Ноль процентов и «не из чего считать» — разные утверждения."""
    assert builders._percent(0, 0) is None
    assert builders._percent(0, 5) == "0.00"


# ─────────────────────────── Поставщики ───────────────────────────


def test_vendors_report_counts_orders_and_sla_breaches(
    as_role: Callable[..., APIClient],
    make_completed_order: Callable[..., ServiceOrder],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    query: dict[str, str],
) -> None:
    make_completed_order(flight=flight, service=fuel_service, vendor=vendor_alpha)
    make_completed_order(
        flight=flight, service=fuel_service, vendor=vendor_alpha, breach_sla=True
    )

    api = as_role(Role.MANAGER)
    rows = api.get(f"{REPORTS_URL}/{definitions.VENDORS}", query).json()["rows"]

    assert len(rows) == 1
    row = rows[0]
    assert row["vendor"] == vendor_alpha.name
    assert row["orders"] == 2
    assert row["completed"] == 2
    assert row["slaBreaches"] == 1
    # Подтверждены обе, в срок — одна
    assert Decimal(row["onTimeRate"]) == Decimal("50.00")


# ─────────────────── Дебиторская задолженность ───────────────────


def test_receivables_show_issued_unpaid_invoice_with_bucket(
    as_role: Callable[..., APIClient],
    issued_invoice: Invoice,
    client_alpha: Client,
) -> None:
    api = as_role(Role.FINANCE)
    body = api.get(f"{REPORTS_URL}/{definitions.RECEIVABLES_PAYABLES}").json()

    rows = body["rows"]
    assert len(rows) == 1
    row = rows[0]
    assert row["counterparty"] == client_alpha.name
    assert row["document"] == issued_invoice.number
    # Срок оплаты ещё не наступил — просрочки ноль суток
    assert row["bucket"] == "0–30"
    assert Decimal(body["totals"]["amount"]) == Decimal(row["amount"])


# ─────────────────────────── Нарушения SLA ───────────────────────────


def test_sla_register_lists_only_breached_orders(
    as_role: Callable[..., APIClient],
    make_completed_order: Callable[..., ServiceOrder],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    query: dict[str, str],
) -> None:
    make_completed_order(flight=flight, service=fuel_service, vendor=vendor_alpha)
    breached = make_completed_order(
        flight=flight, service=fuel_service, vendor=vendor_alpha, breach_sla=True
    )

    api = as_role(Role.DISPATCHER)
    rows = api.get(f"{REPORTS_URL}/{definitions.SLA_BREACHES}", query).json()["rows"]

    assert len(rows) == 1
    assert rows[0]["flight"] == breached.flight.number
    assert rows[0]["vendor"] == vendor_alpha.name
    # Срок был три часа назад, подтверждение — сейчас
    assert rows[0]["lateHours"] >= 2.9


# ─────────────────────────── Журнал изменений ───────────────────────────


def test_flight_audit_shows_status_changes(
    as_role: Callable[..., APIClient],
    completed_order: ServiceOrder,
    query: dict[str, str],
) -> None:
    api = as_role(Role.DISPATCHER)
    rows = api.get(f"{REPORTS_URL}/{definitions.FLIGHT_AUDIT}", query).json()["rows"]

    actions = {row["action"] for row in rows}
    assert "status_changed" in actions or "created" in actions, rows
    assert all(row["actor"] for row in rows)


# ─────────────────────────── Права ───────────────────────────


def test_dispatcher_cannot_build_financial_report(
    as_role: Callable[..., APIClient], query: dict[str, str]
) -> None:
    """`SPEC.md § 2.2`: маржа диспетчеру в отчёте не показывается."""
    api = as_role(Role.DISPATCHER)
    response = api.get(f"{REPORTS_URL}/{definitions.FINANCIAL}", query)
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_dispatcher_cannot_build_vendor_volume_report(
    as_role: Callable[..., APIClient], query: dict[str, str]
) -> None:
    """В отчёте по поставщикам есть объём закупки — это финансовая величина."""
    api = as_role(Role.DISPATCHER)
    response = api.get(f"{REPORTS_URL}/{definitions.VENDORS}", query)
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_finance_can_build_operational_report(
    as_role: Callable[..., APIClient], query: dict[str, str]
) -> None:
    """Операционный отчёт финансисту не закрыт: в нём нет закрытых сведений."""
    api = as_role(Role.FINANCE)
    response = api.get(f"{REPORTS_URL}/{definitions.FLIGHTS_PERIOD}", query)
    assert response.status_code == status.HTTP_200_OK, response.data


@pytest.mark.parametrize("role", [Role.CLIENT, Role.VENDOR])
def test_portal_roles_have_no_reports(
    as_role: Callable[..., APIClient], role: str, client_alpha: Client, vendor_alpha: Vendor
) -> None:
    """Порталам сводные отчёты не показываются вовсе (`BACKEND.md § 3.7`)."""
    extra: dict[str, Any] = (
        {"client": client_alpha} if role == Role.CLIENT else {"vendor": vendor_alpha}
    )
    api = as_role(role, **extra)
    assert api.get(REPORTS_URL).status_code == status.HTTP_403_FORBIDDEN


def test_unknown_report_code_is_not_found(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.MANAGER)
    response = api.get(f"{REPORTS_URL}/margin_by_moon_phase")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["error"]["code"] == "NOT_FOUND"


# ─────────────────────────── Разметка стенда ───────────────────────────


def test_report_from_the_stand_is_marked_as_such(
    as_role: Callable[..., APIClient], settings: Any, query: dict[str, str]
) -> None:
    """`CLAUDE.md § 4`: отчёт со стенда опознаётся как отчёт со стенда."""
    settings.DEMO_DATA = True
    api = as_role(Role.MANAGER)
    assert api.get(f"{REPORTS_URL}/{definitions.FLIGHTS_PERIOD}", query).json()["isDemo"] is True

    settings.DEMO_DATA = False
    assert (
        api.get(f"{REPORTS_URL}/{definitions.FLIGHTS_PERIOD}", query).json()["isDemo"] is False
    )
