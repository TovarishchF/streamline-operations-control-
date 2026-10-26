"""Сроки SLA заявки и их нарушение `[ТЗ 3.2.3]` (`DOMAIN.md § 7.6`, G-39).

Приёмка M5: просроченная заявка помечается нарушением SLA фоновой задачей,
повторно не дублируется.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from rest_framework import status

from accounts.models import Role
from audit.models import AuditEntry
from comms.models import Notification
from core.clock import now
from orders.models import ServiceOrder, ServiceOrderStatus, SlaRule
from orders.services import orders as order_services
from orders.services import sla, transitions
from orders.tasks import check_sla

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User
    from catalog.models import Service, VendorPrice
    from counterparties.models import Vendor, VendorContract
    from flights.models import Flight

pytestmark = pytest.mark.django_db

SLA_URL = "/api/v1/sla-rules"


def _place(flight: Flight, service: Service, vendor: Vendor, actor: User) -> ServiceOrder:
    return order_services.create_order(
        flight=flight,
        service=service,
        leg="departure",
        quantity=Decimal(1000),
        vendor=vendor,
        attributes={},
        override_reason="",
        actor=actor,
    )


@pytest.fixture
def placed(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> ServiceOrder:
    return _place(flight, fuel_service, vendor_alpha, dispatcher)


# ─────────────────────────── Выбор правила ───────────────────────────


def test_default_rules_from_g39_are_loaded() -> None:
    """Значения по умолчанию приходят миграцией, а не живут только в коде."""
    defaults = dict(
        SlaRule.objects.filter(vendor__isnull=True, superseded_at__isnull=True).values_list(
            "category", "confirm_minutes"
        )
    )
    assert defaults == {
        "": 240,
        "fuel": 120,
        "handling": 240,
        "catering": 240,
        "transport": 240,
        "permits": 1440,
        "deicing": 60,
    }


def test_fuel_order_gets_the_fuel_deadline(placed: ServiceOrder) -> None:
    assert placed.ordered_at is not None
    assert placed.sla_confirm_deadline == placed.ordered_at + timedelta(minutes=120)
    assert placed.sla_completion_deadline is None


def test_vendor_rule_beats_category_rule(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    sla.create_rule(
        category="",
        vendor_id=vendor_alpha.pk,
        confirm_minutes=30,
        completion_minutes=90,
        penalty_kind="none",
        penalty_value=None,
        actor=dispatcher,
    )
    order = _place(flight, fuel_service, vendor_alpha, dispatcher)

    assert order.ordered_at is not None
    assert order.sla_confirm_deadline == order.ordered_at + timedelta(minutes=30)
    moment = flight.std_utc
    assert order.sla_completion_deadline == moment + timedelta(minutes=90)


def test_vendor_and_category_rule_is_the_most_specific(
    vendor_alpha: Vendor, dispatcher: User
) -> None:
    for category, vendor_id, minutes in (
        ("fuel", vendor_alpha.pk, 15),
        ("", vendor_alpha.pk, 30),
    ):
        sla.create_rule(
            category=category,
            vendor_id=vendor_id,
            confirm_minutes=minutes,
            completion_minutes=None,
            penalty_kind="none",
            penalty_value=None,
            actor=dispatcher,
        )

    assert sla.terms_for(category="fuel", vendor_id=vendor_alpha.pk).confirm_minutes == 15
    assert sla.terms_for(category="catering", vendor_id=vendor_alpha.pk).confirm_minutes == 30
    assert sla.terms_for(category="catering", vendor_id=None).confirm_minutes == 240


def test_new_rule_supersedes_and_keeps_history(placed: ServiceOrder, dispatcher: User) -> None:
    """Правка справочника не переписывает сроки уже оформленных заявок."""
    deadline = placed.sla_confirm_deadline
    sla.create_rule(
        category="fuel",
        vendor_id=None,
        confirm_minutes=45,
        completion_minutes=None,
        penalty_kind="none",
        penalty_value=None,
        actor=dispatcher,
    )

    fuel_rules = SlaRule.objects.filter(category="fuel", vendor__isnull=True)
    assert fuel_rules.count() == 2
    assert fuel_rules.filter(superseded_at__isnull=True).get().confirm_minutes == 45
    placed.refresh_from_db()
    assert placed.sla_confirm_deadline == deadline


# ─────────────────────────── Фоновая проверка ───────────────────────────


def test_overdue_order_is_marked_once(placed: ServiceOrder, dispatcher: User) -> None:
    ServiceOrder.objects.filter(pk=placed.pk).update(
        sla_confirm_deadline=now() - timedelta(hours=1)
    )

    assert check_sla() == 1
    placed.refresh_from_db()
    assert placed.sla_breached is True
    assert AuditEntry.objects.filter(entity_id=placed.pk, action="sla_breached").count() == 1
    assert Notification.objects.filter(user=dispatcher, kind="sla_breach").count() == 1

    # Повторный проход ничего не дублирует.
    assert check_sla() == 0
    assert AuditEntry.objects.filter(entity_id=placed.pk, action="sla_breached").count() == 1
    assert Notification.objects.filter(user=dispatcher, kind="sla_breach").count() == 1


def test_order_within_deadline_is_not_marked(placed: ServiceOrder) -> None:
    assert check_sla() == 0
    placed.refresh_from_db()
    assert placed.sla_breached is False


def test_confirmation_after_task_does_not_notify_again(
    placed: ServiceOrder, vendor_alpha: Vendor, make_user: Callable[..., User], dispatcher: User
) -> None:
    ServiceOrder.objects.filter(pk=placed.pk).update(
        sla_confirm_deadline=now() - timedelta(hours=1)
    )
    check_sla()

    placed.refresh_from_db()
    transitions.apply_transition(
        placed, "confirm", actor=make_user(Role.VENDOR, suffix="v", vendor=vendor_alpha)
    )

    placed.refresh_from_db()
    assert placed.status == ServiceOrderStatus.CONFIRMED
    assert placed.sla_breached is True
    assert Notification.objects.filter(user=dispatcher, kind="sla_breach").count() == 1


def test_draft_ordered_by_transition_gets_deadline(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    """Черновик, заказанный переходом, не выпадает из проверки SLA."""
    draft = order_services.create_order(
        flight=flight,
        service=fuel_service,
        leg="departure",
        quantity=Decimal(1000),
        vendor=None,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )
    draft = order_services.assign_vendor(order=draft, vendor=vendor_alpha, actor=dispatcher)
    transitions.apply_transition(draft, "order", actor=dispatcher)

    draft.refresh_from_db()
    assert draft.status == ServiceOrderStatus.ORDERED
    assert draft.ordered_at is not None
    assert draft.sla_confirm_deadline == draft.ordered_at + timedelta(minutes=120)


def test_late_completion_is_a_completion_breach(
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
    dispatcher: User,
) -> None:
    sla.create_rule(
        category="fuel",
        vendor_id=None,
        confirm_minutes=120,
        completion_minutes=60,
        penalty_kind="none",
        penalty_value=None,
        actor=dispatcher,
    )
    order = _place(flight, fuel_service, vendor_alpha, dispatcher)
    transitions.apply_transition(order, "confirm", actor=dispatcher)
    transitions.apply_transition(order, "begin", actor=dispatcher)
    order_services.update_order(
        order=order,
        changes={
            "actual_start_at": flight.std_utc,
            "actual_end_at": flight.std_utc + timedelta(minutes=90),
            "actual_quantity": Decimal(1000),
        },
        actor=dispatcher,
    )
    transitions.apply_transition(order, "finish", actor=dispatcher)

    order.refresh_from_db()
    assert order.sla_completion_breached is True
    assert order.sla_breached is False


# ─────────────────────────── API справочника ───────────────────────────


def test_rules_are_listed(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.ADMIN).get(SLA_URL)

    assert response.status_code == status.HTTP_200_OK
    body = response.json()["data"]
    fuel = next(rule for rule in body if rule["scope"]["category"] == "fuel")
    assert fuel == {
        "id": fuel["id"],
        "scope": {"category": "fuel", "vendorId": None},
        "confirmMinutes": 120,
        "completionMinutes": None,
        "penalty": {"kind": "none", "value": None},
    }


def test_admin_adds_a_rule_and_it_supersedes(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    api = as_role(Role.ADMIN)
    payload = {
        "scope": {"category": "fuel", "vendorId": vendor_alpha.pk},
        "confirmMinutes": 45,
        "completionMinutes": 120,
        "penalty": {"kind": "percent", "value": "5"},
    }
    created = api.post(SLA_URL, payload, format="json", headers={"Idempotency-Key": "sla-000001"})
    assert created.status_code == status.HTTP_201_CREATED, created.json()
    assert created.json()["penalty"] == {"kind": "percent", "value": "5.0000"}

    again = api.post(
        SLA_URL,
        {**payload, "confirmMinutes": 50},
        format="json",
        headers={"Idempotency-Key": "sla-000002"},
    )
    assert again.status_code == status.HTTP_201_CREATED

    active = [
        rule
        for rule in api.get(SLA_URL).json()["data"]
        if rule["scope"]["vendorId"] == vendor_alpha.pk
    ]
    assert [rule["confirmMinutes"] for rule in active] == [50]
    assert AuditEntry.objects.filter(action="sla_rule_created").count() == 2


def test_penalty_without_size_is_refused(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.ADMIN).post(
        SLA_URL,
        {"scope": {"category": "fuel"}, "confirmMinutes": 45, "penalty": {"kind": "fixed"}},
        format="json",
        headers={"Idempotency-Key": "sla-000003"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_dispatcher_reads_but_cannot_add(as_role: Callable[..., APIClient]) -> None:
    api = as_role(Role.DISPATCHER)
    assert api.get(SLA_URL).status_code == status.HTTP_200_OK
    response = api.post(
        SLA_URL,
        {"scope": {"category": "fuel"}, "confirmMinutes": 45},
        format="json",
        headers={"Idempotency-Key": "sla-000004"},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_adding_requires_idempotency_key(as_role: Callable[..., APIClient]) -> None:
    response = as_role(Role.ADMIN).post(
        SLA_URL, {"scope": {"category": "fuel"}, "confirmMinutes": 45}, format="json"
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_portal_roles_have_no_access(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    response = as_role(Role.VENDOR, vendor=vendor_alpha).get(SLA_URL)
    assert response.status_code == status.HTTP_403_FORBIDDEN
