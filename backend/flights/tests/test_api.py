"""Эндпоинты рейсов `[ТЗ 3.1]`.

Здесь же закрываются два критерия приёмки M3, сформулированные через рейсы:
финансист не создаёт рейсы, клиент не видит чужие.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import pytest
from django.urls import reverse

from accounts.models import Role
from core import clock
from flights.models import Flight, FlightRequest, FlightRequestStatus, FlightStatus
from flights.services import planning
from orders.models import ServiceOrderStatus

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from catalog.models import Airport
    from counterparties.models import Client
    from fleet.models import Aircraft


def _payload(client: Client, **extra: object) -> dict[str, object]:
    return {
        "clientId": client.pk,
        "type": "charter",
        "depIcao": "UUWW",
        "arrIcao": "ULLI",
        "stdUtc": (clock.now() + timedelta(days=1)).isoformat(),
        "paxCount": 4,
        **extra,
    }


@pytest.mark.django_db
class TestPermissions:
    def test_finance_cannot_create_a_flight(
        self, as_role: Callable[..., APIClient], airports: dict[str, Airport], client_alpha: Client
    ) -> None:
        """Критерий приёмки M3, проверенный на настоящем эндпоинте."""
        api = as_role(Role.FINANCE)

        response = api.post(
            reverse("v1:flight-list"),
            _payload(client_alpha),
            format="json",
            headers={"Idempotency-Key": "flight-key-0001"},
        )

        assert response.status_code == 403
        assert response.data["error"]["code"] == "PERMISSION_DENIED"

    def test_dispatcher_creates_a_flight(
        self, as_role: Callable[..., APIClient], airports: dict[str, Airport], client_alpha: Client
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:flight-list"),
            _payload(client_alpha),
            format="json",
            headers={"Idempotency-Key": "flight-key-0002"},
        )

        assert response.status_code == 201
        assert response.data["number"].startswith("SLG-")
        assert response.data["distanceNm"] > 0
        assert response.data["staUtc"] > response.data["stdUtc"]

    def test_finance_may_read_the_schedule(
        self, as_role: Callable[..., APIClient], airports: dict[str, Airport]
    ) -> None:
        """Отказ должен быть про создание, а не про раздел целиком."""
        api = as_role(Role.FINANCE)

        assert api.get(reverse("v1:flight-list")).status_code == 200


@pytest.mark.django_db
class TestClientIsolation:
    def test_client_does_not_see_another_clients_flight(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
        client_beta: Client,
    ) -> None:
        """Критерий приёмки M3 на рейсах: чужой рейс даёт 404, а не 403."""
        own = planning.create_flight(
            client=client_alpha, dep_icao="UUWW", arr_icao="ULLI",
            std_utc=clock.now() + timedelta(days=1),
        )
        other = planning.create_flight(
            client=client_beta, dep_icao="UUWW", arr_icao="ULLI",
            std_utc=clock.now() + timedelta(days=2),
        )
        api = as_role(Role.CLIENT, client=client_alpha)

        listing = api.get(reverse("v1:flight-list"))
        detail = api.get(reverse("v1:flight-detail", args=[other.pk]))

        assert [item["id"] for item in listing.data["data"]] == [own.pk]
        assert listing.data["meta"]["total"] == 1
        assert detail.status_code == 404

    def test_dispatcher_sees_every_flight(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
        client_beta: Client,
    ) -> None:
        for owner in (client_alpha, client_beta):
            planning.create_flight(
                client=owner, dep_icao="UUWW", arr_icao="ULLI",
                std_utc=clock.now() + timedelta(days=1),
            )
        api = as_role(Role.DISPATCHER)

        assert api.get(reverse("v1:flight-list")).data["meta"]["total"] == 2


@pytest.mark.django_db
class TestTransitionEndpoint:
    def test_blocked_transition_answers_409_with_conditions(
        self, as_role: Callable[..., APIClient], flight_in_work: Flight
    ) -> None:
        """Критерий приёмки M4: отказ со списком невыполненных условий."""
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:flight-status", args=[flight_in_work.pk]),
            {"transition": "ready"},
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "GUARD_NOT_SATISFIED"
        assert any(
            "Не подтверждены заявки" in item
            for item in response.data["error"]["details"]["unsatisfied"]
        )

    def test_allowed_transition_changes_the_status(
        self, as_role: Callable[..., APIClient], flight_in_work: Flight
    ) -> None:
        flight_in_work.service_orders.update(status=ServiceOrderStatus.CONFIRMED)
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:flight-status", args=[flight_in_work.pk]),
            {"transition": "ready"},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["status"] == FlightStatus.READY_FOR_DEPARTURE

    def test_card_lists_blocked_transitions_with_reasons(
        self, as_role: Callable[..., APIClient], flight_in_work: Flight
    ) -> None:
        """Недоступный переход виден с причиной, а не спрятан (`SPEC § 4.4`)."""
        api = as_role(Role.DISPATCHER)

        response = api.get(reverse("v1:flight-detail", args=[flight_in_work.pk]))

        blocked = {item["transition"]: item for item in response.data["blockedTransitions"]}
        assert "ready" in blocked
        assert blocked["ready"]["unmetConditions"]

    def test_history_returns_the_audit_trail(
        self, as_role: Callable[..., APIClient], flight_in_work: Flight
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.get(reverse("v1:flight-history", args=[flight_in_work.pk]))

        actions = {item["action"] for item in response.data["data"]}
        assert {"created", "status_changed"} <= actions


@pytest.mark.django_db
class TestConflictsEndpoint:
    def test_conflicts_are_listed_with_reason_and_severity(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
        aircraft: Aircraft,
    ) -> None:
        for _ in range(2):
            planning.create_flight(
                client=client_alpha, dep_icao="UUWW", arr_icao="ULLI",
                std_utc=clock.now() + timedelta(hours=6), aircraft=aircraft,
            )
        api = as_role(Role.DISPATCHER)

        response = api.get(reverse("v1:flight-conflicts"))

        kinds = {item["kind"] for item in response.data["data"]}
        assert "overlap" in kinds
        overlap = next(item for item in response.data["data"] if item["kind"] == "overlap")
        assert overlap["severity"] == "critical"
        assert overlap["message"]


@pytest.mark.django_db
class TestFlightRequests:
    def test_approval_creates_a_flight(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
    ) -> None:
        """`SPEC § 2.2`: клиент подаёт заявку, рейс создаёт диспетчер."""
        request = FlightRequest.objects.create(
            organization=client_alpha.organization,
            client=client_alpha,
            dep_icao="UUWW",
            arr_icao="ULLI",
            requested_std_utc=clock.now() + timedelta(days=2),
            pax_count=3,
        )
        api = as_role(Role.DISPATCHER)

        response = api.post(reverse("v1:flight-request-approve", args=[request.pk]))

        assert response.status_code == 201
        request.refresh_from_db()
        assert request.status == FlightRequestStatus.APPROVED
        assert request.flight_id == response.data["id"]

    def test_rejection_requires_a_reason(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
    ) -> None:
        request = FlightRequest.objects.create(
            organization=client_alpha.organization,
            client=client_alpha,
            dep_icao="UUWW",
            arr_icao="ULLI",
            requested_std_utc=clock.now() + timedelta(days=2),
        )
        api = as_role(Role.DISPATCHER)

        response = api.post(
            reverse("v1:flight-request-reject", args=[request.pk]), {}, format="json"
        )

        assert response.status_code == 400

    def test_client_sees_only_own_requests(
        self,
        as_role: Callable[..., APIClient],
        airports: dict[str, Airport],
        client_alpha: Client,
        client_beta: Client,
    ) -> None:
        for owner in (client_alpha, client_beta):
            FlightRequest.objects.create(
                organization=owner.organization, client=owner,
                dep_icao="UUWW", arr_icao="ULLI",
                requested_std_utc=clock.now() + timedelta(days=2),
            )
        api = as_role(Role.CLIENT, client=client_alpha)

        response = api.get(reverse("v1:flight-request-list"))

        assert response.data["meta"]["total"] == 1


@pytest.mark.django_db
class TestIdempotency:
    def test_repeat_with_the_same_key_does_not_create_a_second_flight(
        self, as_role: Callable[..., APIClient], airports: dict[str, Airport], client_alpha: Client
    ) -> None:
        """Диспетчер нажимает кнопку дважды — на плохой связи это норма."""
        api = as_role(Role.DISPATCHER)
        payload = _payload(client_alpha)
        headers = {"Idempotency-Key": "flight-key-0003"}

        first = api.post(reverse("v1:flight-list"), payload, format="json", headers=headers)
        second = api.post(reverse("v1:flight-list"), payload, format="json", headers=headers)

        assert first.data["id"] == second.data["id"]
        assert Flight.objects.count() == 1

    def test_creation_without_a_key_is_refused(
        self, as_role: Callable[..., APIClient], airports: dict[str, Airport], client_alpha: Client
    ) -> None:
        api = as_role(Role.DISPATCHER)

        response = api.post(reverse("v1:flight-list"), _payload(client_alpha), format="json")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"
