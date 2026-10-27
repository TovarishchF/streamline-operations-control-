"""Порталы клиента и поставщика `[ТЗ 3.5.3, 4.3]` (`SPEC.md § 8.4, 8.5`).

Приёмка M8:
* в API портала клиента нигде не возвращаются закупочные цены и данные
  поставщиков;
* заявка клиента становится рейсом только после подтверждения диспетчером.
"""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from billing.services import documents
from core.clock import now
from flights.models import Flight, FlightRequest, FlightRequestStatus, FlightTemplate
from orders.models import ServiceOrder
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import User
    from catalog.models import Service
    from counterparties.models import Client, Vendor

pytestmark = pytest.mark.django_db

CLIENT = "/api/v1/portal/client"
VENDOR = "/api/v1/portal/vendor"
# Поля, которых в портале клиента не бывает ни при каких данных.
FORBIDDEN_KEYS = ("purchase", "cost", "vendor", "sale", "margin", "tariff", "contract")


def place(flight: Flight, service: Service, vendor: Vendor, actor: User) -> ServiceOrder:
    return order_services.create_order(
        flight=flight,
        service=service,
        leg="departure",
        quantity=Decimal(1000),
        vendor=vendor,
        attributes={"grade": "Jet A-1"},
        override_reason="",
        actor=actor,
    )


def keys_of(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in keys_of(item)}
    if isinstance(value, list):
        return {key for item in value for key in keys_of(item)}
    return set()


def as_client(as_role: Callable[..., APIClient], client: Client) -> APIClient:
    return as_role(Role.CLIENT, client=client)


# ─────────────────────────── Портал клиента ───────────────────────────


def test_client_sees_only_own_flights(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    own_flight: Flight,
    foreign_flight: Flight,
) -> None:
    body = as_client(as_role, client_alpha).get(f"{CLIENT}/flights").json()

    assert [row["number"] for row in body["data"]] == [own_flight.number]
    assert body["meta"]["total"] == 1


def test_client_portal_carries_no_purchase_prices_or_vendors(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    """Приёмка M8: ни закупки, ни поставщика — ни в одном ответе портала."""
    place(own_flight, fuel_service, priced_vendor, dispatcher)
    finance = as_role(Role.FINANCE, suffix="docs")
    quote = finance.post(
        "/api/v1/quotes",
        {"flightId": own_flight.pk},
        format="json",
        headers={"Idempotency-Key": "portal-quote-1"},
    ).json()
    finance.post(
        f"/api/v1/quotes/{quote['id']}/issue",
        format="json",
        headers={"Idempotency-Key": "portal-quote-2"},
    )

    api = as_client(as_role, client_alpha)
    responses = [api.get(f"{CLIENT}/flights").json(), api.get(f"{CLIENT}/documents").json()]

    for body in responses:
        keys = {key.lower() for key in keys_of(body)}
        leaked = [key for key in keys if any(word in key for word in FORBIDDEN_KEYS)]
        assert leaked == []
        assert priced_vendor.name not in json.dumps(body, ensure_ascii=False)

    services = responses[0]["data"][0]["services"]
    assert services == [
        {
            "serviceName": {"ru": "Заправка Jet A-1", "en": "Jet A-1 refuelling"},
            "leg": "departure",
            "status": "ordered",
        }
    ]


def test_rejected_order_is_not_shown_to_the_client(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    order = place(own_flight, fuel_service, priced_vendor, dispatcher)
    transitions.apply_transition(order, "reject", actor=dispatcher, comment="Нет топлива")

    row = as_client(as_role, client_alpha).get(f"{CLIENT}/flights").json()["data"][0]
    assert row["services"] == []


def test_documents_show_issued_not_drafts_and_only_own(
    as_role: Callable[..., APIClient],
    make_user: Callable[..., User],
    client_alpha: Client,
    own_flight: Flight,
    foreign_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    place(own_flight, fuel_service, priced_vendor, dispatcher)
    finance = make_user(Role.FINANCE, suffix="q")
    draft = documents.build_quote(flight=own_flight, valid_until=None, actor=finance)
    issued = documents.issue_quote(
        quote=documents.build_quote(flight=own_flight, valid_until=None, actor=finance),
        actor=finance,
    )

    body = as_client(as_role, client_alpha).get(f"{CLIENT}/documents").json()

    ids = [row["id"] for row in body["data"]]
    assert ids == [issued.pk]
    assert draft.pk not in ids
    assert body["data"][0]["kind"] == "quote"
    assert body["data"][0]["number"] == issued.number


def test_staff_without_a_client_has_no_client_portal(
    as_role: Callable[..., APIClient], own_flight: Flight
) -> None:
    assert as_role(Role.DISPATCHER).get(f"{CLIENT}/flights").status_code == (
        status.HTTP_403_FORBIDDEN
    )


def test_vendor_cannot_open_the_client_portal(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor
) -> None:
    response = as_role(Role.VENDOR, vendor=vendor_alpha).get(f"{CLIENT}/flights")
    assert response.status_code == status.HTTP_403_FORBIDDEN


# ─────────────────────────── Заявка на рейс ───────────────────────────


def request_payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "depIcao": "UUWW",
        "arrIcao": "ULLI",
        "requestedStdUtc": (now() + timedelta(days=3)).isoformat(),
        "paxCount": 6,
        "comment": "Нужен борт на восемь мест",
    }
    body.update(overrides)
    return body


def test_request_becomes_a_flight_only_after_the_dispatcher(
    as_role: Callable[..., APIClient],
    make_user: Callable[..., User],
    api: APIClient,
    client_alpha: Client,
    airports: None,
) -> None:
    """Приёмка M8: заявка клиента — не рейс, пока её не подтвердил диспетчер."""
    portal = as_client(as_role, client_alpha)
    flights_before = Flight.objects.count()

    created = portal.post(
        f"{CLIENT}/flight-requests",
        request_payload(),
        format="json",
        headers={"Idempotency-Key": "portal-req-0001"},
    )

    assert created.status_code == status.HTTP_201_CREATED, created.json()
    body = created.json()
    assert body["status"] == FlightRequestStatus.PENDING
    assert body["clientId"] == client_alpha.pk
    assert body["createdFlightId"] is None
    assert Flight.objects.count() == flights_before

    api.force_authenticate(user=make_user(Role.DISPATCHER, suffix="review"))
    approved = api.post(f"/api/v1/flight-requests/{body['id']}/approve", format="json")
    assert approved.status_code == status.HTTP_201_CREATED, approved.json()
    request = FlightRequest.objects.get(pk=body["id"])
    assert request.status == FlightRequestStatus.APPROVED
    assert request.flight is not None
    assert request.flight.client_id == client_alpha.pk


@pytest.mark.parametrize(
    ("case", "overrides"),
    [
        ("same-airport", {"arrIcao": "UUWW"}),
        ("in-the-past", {"requestedStdUtc": "2020-01-01T10:00:00Z"}),
        ("unknown-airport", {"depIcao": "ZZZZ"}),
    ],
)
def test_impossible_request_is_refused(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    airports: None,
    case: str,
    overrides: dict[str, Any],
) -> None:
    response = as_client(as_role, client_alpha).post(
        f"{CLIENT}/flight-requests",
        request_payload(**overrides),
        format="json",
        headers={"Idempotency-Key": f"portal-req-{case}"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_foreign_template_is_refused(
    as_role: Callable[..., APIClient],
    client_alpha: Client,
    client_beta: Client,
    organization: Any,
    airports: None,
) -> None:
    from catalog.models import AircraftType

    template = FlightTemplate.objects.create(
        organization=organization,
        name="Чужой шаблон",
        client=client_beta,
        aircraft_type=AircraftType.objects.create(
            icao_type="C56X",
            name_ru="Citation XLS",
            name_en="Citation XLS",
            category="light",
            seats=8,
            cruise_speed_kts=430,
            fuel_burn_kg_per_hour=600,
            turnaround_min=40,
        ),
        dep_icao="UUWW",
        arr_icao="ULLI",
        dep_time_local="09:00",
        weekdays=[1],
    )
    response = as_client(as_role, client_alpha).post(
        f"{CLIENT}/flight-requests",
        request_payload(templateId=template.pk),
        format="json",
        headers={"Idempotency-Key": "portal-req-tmpl"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_request_requires_idempotency_key(
    as_role: Callable[..., APIClient], client_alpha: Client, airports: None
) -> None:
    response = as_client(as_role, client_alpha).post(
        f"{CLIENT}/flight-requests", request_payload(), format="json"
    )
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_dispatcher_cannot_submit_client_requests(
    as_role: Callable[..., APIClient], airports: None
) -> None:
    response = as_role(Role.DISPATCHER).post(
        f"{CLIENT}/flight-requests",
        request_payload(),
        format="json",
        headers={"Idempotency-Key": "portal-req-0002"},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


# ─────────────────────────── Портал поставщика ───────────────────────────


def test_vendor_sees_own_sent_orders_without_the_sale_price(
    as_role: Callable[..., APIClient],
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    placed = place(own_flight, fuel_service, priced_vendor, dispatcher)
    order_services.create_order(
        flight=own_flight,
        service=fuel_service,
        leg="arrival",
        quantity=Decimal(1),
        vendor=None,
        attributes={},
        override_reason="",
        actor=dispatcher,
    )

    body = as_role(Role.VENDOR, vendor=priced_vendor).get(f"{VENDOR}/orders").json()

    assert [row["id"] for row in body["data"]] == [placed.pk]
    row = body["data"][0]
    assert row["agreedPrice"] == {"amount": "70000.0000", "currency": "RUB"}
    assert row["flightNumber"] == own_flight.number
    assert row["dispatcherContact"]["email"] == dispatcher.email
    assert not any("sale" in key.lower() or "margin" in key.lower() for key in keys_of(body))


def test_needs_response_filter(
    as_role: Callable[..., APIClient],
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    first = place(own_flight, fuel_service, priced_vendor, dispatcher)
    second = place(own_flight, fuel_service, priced_vendor, dispatcher)
    transitions.apply_transition(second, "confirm", actor=dispatcher)

    body = (
        as_role(Role.VENDOR, vendor=priced_vendor).get(f"{VENDOR}/orders?needsResponse=true").json()
    )
    assert [row["id"] for row in body["data"]] == [first.pk]


def test_vendor_does_not_see_another_vendors_orders(
    as_role: Callable[..., APIClient],
    organization: Any,
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    from counterparties.models import Vendor as VendorModel

    place(own_flight, fuel_service, priced_vendor, dispatcher)
    other = VendorModel.objects.create(organization=organization, name="Другой поставщик")

    body = as_role(Role.VENDOR, vendor=other, suffix="other").get(f"{VENDOR}/orders").json()
    assert body["data"] == []


def test_vendor_payables_and_performance_are_own(
    as_role: Callable[..., APIClient],
    own_flight: Flight,
    fuel_service: Service,
    priced_vendor: Vendor,
    dispatcher: User,
) -> None:
    order = place(own_flight, fuel_service, priced_vendor, dispatcher)
    transitions.apply_transition(order, "confirm", actor=dispatcher)
    transitions.apply_transition(order, "begin", actor=dispatcher)
    started = now()
    order = order_services.update_order(
        order=order,
        changes={
            "actual_start_at": started,
            "actual_end_at": started + timedelta(minutes=20),
            "actual_quantity": Decimal(1000),
        },
        actor=dispatcher,
    )
    transitions.apply_transition(order, "finish", actor=dispatcher)

    api = as_role(Role.VENDOR, vendor=priced_vendor)
    payables = api.get(f"{VENDOR}/payables").json()
    assert payables["meta"]["total"] == 1
    assert payables["data"][0]["vendorId"] == priced_vendor.pk

    performance = api.get(f"{VENDOR}/performance").json()
    assert performance["sufficientData"] is False
    assert performance["orderCount"] == 1


def test_client_has_no_vendor_portal(
    as_role: Callable[..., APIClient], client_alpha: Client
) -> None:
    api = as_client(as_role, client_alpha)
    assert api.get(f"{VENDOR}/orders").status_code == status.HTTP_403_FORBIDDEN
    assert api.get(f"{VENDOR}/performance").status_code == status.HTTP_403_FORBIDDEN
