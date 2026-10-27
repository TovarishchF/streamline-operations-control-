"""Автомат рейса `[ТЗ 3.1.1]` (`DOMAIN.md § 5.1`).

Критерии приёмки M4:
* переход в «Готов к вылету» с неподтверждённой услугой даёт отказ
  со списком невыполненных условий;
* прямое присвоение статуса в обход автомата невозможно.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest

from audit.models import AuditEntry
from catalog.models import Service, ServiceCategory
from core import clock
from core.exceptions import GuardNotSatisfied, TransitionNotAllowed
from flights import machine
from flights.models import Flight, FlightStatus, ServiceLeg
from flights.services import transitions
from flights.services.guards import GUARDS
from orders.models import ServiceOrder, ServiceOrderStatus

if TYPE_CHECKING:
    from accounts.models import User
    from counterparties.models import Vendor


def _order(flight: Flight, code: str = "HND_BASIC", **extra: object) -> ServiceOrder:
    service, _ = Service.objects.get_or_create(
        code=code,
        defaults={
            "category": ServiceCategory.HANDLING,
            "name_ru": code,
            "name_en": code,
            "unit": "flight",
        },
    )
    return ServiceOrder.objects.create(
        flight=flight,
        service=service,
        leg=ServiceLeg.DEPARTURE,
        airport_icao=flight.dep_icao,
        **extra,
    )


class TestMachineDefinition:
    """Определение автомата общее с клиентом (ADR-015)."""

    def test_every_guard_is_implemented_on_the_server(self) -> None:
        """Объявленное в автомате, но не реализованное условие пропускало бы
        переход молча — это дыра в проверке, а не мелочь."""
        declared = {
            name for item in machine.transitions() for name in item.get("guards", [])
        }

        assert declared <= set(GUARDS), sorted(declared - set(GUARDS))

    def test_no_unused_guards(self) -> None:
        declared = {
            name for item in machine.transitions() for name in item.get("guards", [])
        }

        assert set(GUARDS) <= declared, sorted(set(GUARDS) - declared)

    def test_states_match_the_model(self) -> None:
        assert set(machine.definition()["states"]) == set(FlightStatus.values)


@pytest.mark.django_db
class TestProtectedField:
    def test_direct_assignment_is_impossible(self, flight: Flight) -> None:
        """`CLAUDE.md § 3` п. 3: статус меняется только переходом."""
        with pytest.raises(AttributeError):
            flight.status = FlightStatus.COMPLETED

    def test_queryset_update_does_not_go_through_the_machine(self, flight: Flight) -> None:
        """`QuerySet.update()` поле обойдёт — и это известное ограничение.

        Защита поля работает на уровне объекта. Массовое обновление статусов
        не используется нигде в коде, и тест фиксирует границу: если такой
        вызов появится, он должен появиться осознанно.
        """
        Flight.objects.filter(pk=flight.pk).update(status=FlightStatus.COMPLETED)
        flight.refresh_from_db()

        assert flight.status == FlightStatus.COMPLETED


@pytest.mark.django_db
class TestStart:
    def test_refuses_without_aircraft_and_orders(
        self, flight: Flight, dispatcher: User
    ) -> None:
        with pytest.raises(GuardNotSatisfied) as error:
            transitions.apply_transition(flight, "start", actor=dispatcher)

        unsatisfied = error.value.details["unsatisfied"]
        assert "Не назначен борт" in unsatisfied
        assert "Не создано ни одной заявки на услугу" in unsatisfied

    def test_passes_when_conditions_are_met(
        self, flight_with_aircraft: Flight, dispatcher: User
    ) -> None:
        _order(flight_with_aircraft)

        transitions.apply_transition(flight_with_aircraft, "start", actor=dispatcher)

        assert flight_with_aircraft.status == FlightStatus.IN_WORK

    def test_transition_is_recorded_in_audit(
        self, flight_with_aircraft: Flight, dispatcher: User
    ) -> None:
        _order(flight_with_aircraft)

        transitions.apply_transition(flight_with_aircraft, "start", actor=dispatcher)

        entry = AuditEntry.objects.get(entity_id=flight_with_aircraft.pk, action="status_changed")
        assert entry.before == {"status": "planned"}
        assert entry.after == {"status": "in_work"}


@pytest.mark.django_db
class TestReady:
    def test_unconfirmed_order_blocks_with_a_list_of_reasons(
        self, flight_in_work: Flight, dispatcher: User
    ) -> None:
        """Тот самый критерий приёмки: отказ со списком условий."""
        with pytest.raises(GuardNotSatisfied) as error:
            transitions.apply_transition(flight_in_work, "ready", actor=dispatcher)

        unsatisfied = error.value.details["unsatisfied"]
        assert any("Не подтверждены заявки" in item for item in unsatisfied)
        assert flight_in_work.status == FlightStatus.IN_WORK

    def test_rejected_order_is_named_separately(
        self, flight_in_work: Flight, dispatcher: User
    ) -> None:
        order = flight_in_work.service_orders.first()
        assert order is not None
        ServiceOrder.objects.filter(pk=order.pk).update(status=ServiceOrderStatus.REJECTED)

        with pytest.raises(GuardNotSatisfied) as error:
            transitions.apply_transition(flight_in_work, "ready", actor=dispatcher)

        assert any("Отклонены заявки" in item for item in error.value.details["unsatisfied"])

    def test_passes_when_every_order_is_confirmed(
        self, flight_in_work: Flight, dispatcher: User
    ) -> None:
        flight_in_work.service_orders.update(status=ServiceOrderStatus.CONFIRMED)

        transitions.apply_transition(flight_in_work, "ready", actor=dispatcher)

        assert flight_in_work.status == FlightStatus.READY_FOR_DEPARTURE


@pytest.mark.django_db
class TestImpossibleTransitions:
    def test_transition_from_a_wrong_state_is_refused(
        self, flight: Flight, dispatcher: User
    ) -> None:
        with pytest.raises(TransitionNotAllowed):
            transitions.apply_transition(flight, "depart", actor=dispatcher)

    def test_unknown_transition_is_refused(self, flight: Flight) -> None:
        with pytest.raises(TransitionNotAllowed):
            transitions.apply_transition(flight, "teleport")

    def test_available_transitions_reflect_the_state(self, flight: Flight) -> None:
        assert set(transitions.available_transitions(flight)) == {"start", "cancel"}


@pytest.mark.django_db
class TestCancel:
    def test_reason_is_mandatory(self, flight: Flight, dispatcher: User) -> None:
        with pytest.raises(GuardNotSatisfied):
            transitions.apply_transition(flight, "cancel", actor=dispatcher)

    def test_reason_is_stored_and_audited(self, flight: Flight, dispatcher: User) -> None:
        transitions.apply_transition(
            flight,
            "cancel",
            actor=dispatcher,
            reason_code="client_request",
            comment="Клиент перенёс поездку",
        )

        assert flight.status == FlightStatus.CANCELLED
        assert flight.status_reason_code == "client_request"
        entry = AuditEntry.objects.get(entity_id=flight.pk, action="status_changed")
        assert entry.comment == "Клиент перенёс поездку"


@pytest.mark.django_db
class TestDeparture:
    def test_departure_stamps_the_actual_time(
        self, flight_ready: Flight, dispatcher: User
    ) -> None:
        before = clock.now()

        transitions.apply_transition(flight_ready, "depart", actor=dispatcher)

        assert flight_ready.status == FlightStatus.IN_FLIGHT
        assert flight_ready.atd_utc is not None
        assert flight_ready.atd_utc >= before

    def test_arrival_stamps_the_actual_time(
        self, flight_ready: Flight, dispatcher: User
    ) -> None:
        transitions.apply_transition(flight_ready, "depart", actor=dispatcher)

        transitions.apply_transition(flight_ready, "arrive", actor=dispatcher)

        assert flight_ready.status == FlightStatus.ARRIVED
        assert flight_ready.ata_utc is not None

    def test_manual_departure_before_schedule_is_allowed(
        self, flight_ready: Flight, dispatcher: User
    ) -> None:
        """Ручной вылет раньше планового — обычное дело, запрещать нельзя."""
        Flight.objects.filter(pk=flight_ready.pk).update(
            std_utc=clock.now() + timedelta(hours=5)
        )
        flight_ready.refresh_from_db()

        transitions.apply_transition(flight_ready, "depart", actor=dispatcher)

        assert flight_ready.status == FlightStatus.IN_FLIGHT


@pytest.fixture
def flight_arrived(flight_ready: Flight, dispatcher: User) -> Flight:
    transitions.apply_transition(flight_ready, "depart", actor=dispatcher)
    transitions.apply_transition(flight_ready, "arrive", actor=dispatcher)
    flight_ready.service_orders.update(status=ServiceOrderStatus.COMPLETED)
    return flight_ready


@pytest.mark.django_db
class TestComplete:
    """Завершение: счёт выставлен или явно выбрано «без счёта» (`DOMAIN.md § 5.1`)."""

    def test_refused_without_an_invoice(self, flight_arrived: Flight, dispatcher: User) -> None:
        with pytest.raises(GuardNotSatisfied) as error:
            transitions.apply_transition(flight_arrived, "complete", actor=dispatcher)

        assert error.value.details["unsatisfied"] == ["Клиенту не выставлен счёт"]

    def test_draft_invoice_is_not_enough(self, flight_arrived: Flight, dispatcher: User) -> None:
        from billing.models import Invoice

        Invoice.objects.create(
            flight=flight_arrived, client=flight_arrived.client, currency="RUB"
        )

        assert transitions.unmet_conditions(flight_arrived, "complete") == [
            "Клиенту не выставлен счёт"
        ]

    def test_passes_with_an_issued_invoice(
        self, flight_arrived: Flight, dispatcher: User
    ) -> None:
        from billing.models import Invoice, InvoiceStatus

        Invoice.objects.create(
            flight=flight_arrived,
            client=flight_arrived.client,
            currency="RUB",
            number="SOC-I-2026-0001",
            issued_at=clock.now(),
            status=InvoiceStatus.ISSUED,
        )

        transitions.apply_transition(flight_arrived, "complete", actor=dispatcher)

        assert flight_arrived.status == FlightStatus.COMPLETED

    def test_waiver_needs_a_reason(self, flight_arrived: Flight, dispatcher: User) -> None:
        with pytest.raises(GuardNotSatisfied):
            transitions.apply_transition(
                flight_arrived, "complete", actor=dispatcher, complete_without_invoice=True
            )

    def test_waiver_with_a_reason_is_audited(
        self, flight_arrived: Flight, dispatcher: User
    ) -> None:
        transitions.apply_transition(
            flight_arrived,
            "complete",
            actor=dispatcher,
            comment="Рейс выполнен по гарантийному обязательству",
            complete_without_invoice=True,
        )

        assert flight_arrived.status == FlightStatus.COMPLETED
        entry = AuditEntry.objects.get(
            entity_id=flight_arrived.pk, action="status_changed", after__status="completed"
        )
        assert entry.comment == "Без счёта: Рейс выполнен по гарантийному обязательству"

    def test_waiver_belongs_to_completion_only(self, flight: Flight, dispatcher: User) -> None:
        with pytest.raises(GuardNotSatisfied):
            transitions.apply_transition(
                flight,
                "cancel",
                actor=dispatcher,
                reason_code="client_request",
                comment="x",
                complete_without_invoice=True,
            )


@pytest.mark.django_db
def test_reason_is_not_an_unmet_condition_of_the_card(flight: Flight) -> None:
    """Причину вводят в диалоге перехода: отмена не показывается заблокированной."""
    assert transitions.unmet_conditions(flight, "cancel") == []
    assert transitions.check_guards(flight, "cancel") == ["Не указана причина"]


@pytest.fixture
def flight_templates(db: None) -> None:
    from comms.models import MessageChannel, MessageTemplate

    for code in ("flight_cancelled", "flight_confirmed", "order_cancelled"):
        MessageTemplate.objects.create(
            code=code,
            channel=MessageChannel.EMAIL,
            subject_ru=f"{code} {{{{flight.number}}}}",
            subject_en=f"{code} {{{{flight.number}}}}",
            body_ru="Причина: {{change.reason}}",
            body_en="Reason: {{change.reason}}",
        )


@pytest.mark.django_db
class TestEffects:
    """Побочные эффекты переходов (`DOMAIN.md § 5.1`, G-56)."""

    def test_cancel_cascades_to_open_orders(
        self,
        flight: Flight,
        dispatcher: User,
        vendor_alpha: Vendor,
        flight_templates: None,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        from comms.models import OutboxMessage
        from counterparties.models import Contact

        Contact.objects.create(client=flight.client, name="Мария Орлова", email="ops@client.test")
        Contact.objects.create(vendor=vendor_alpha, name="Иван Петров", email="ops@vendor.test")
        draft = _order(flight, "HND_A")
        ordered = _order(flight, "FUEL_A", vendor=vendor_alpha)
        done = _order(flight, "CAT_A", vendor=vendor_alpha)
        ServiceOrder.objects.filter(pk=ordered.pk).update(status=ServiceOrderStatus.ORDERED)
        ServiceOrder.objects.filter(pk=done.pk).update(status=ServiceOrderStatus.COMPLETED)

        with django_capture_on_commit_callbacks(execute=True):
            transitions.apply_transition(
                flight,
                "cancel",
                actor=dispatcher,
                reason_code="client_request",
                comment="Клиент перенёс поездку",
            )

        statuses = dict(flight.service_orders.values_list("pk", "status"))
        assert statuses[draft.pk] == ServiceOrderStatus.CANCELLED
        assert statuses[ordered.pk] == ServiceOrderStatus.CANCELLED
        # Оказанную услугу автомат заявки отменить не даёт.
        assert statuses[done.pk] == ServiceOrderStatus.COMPLETED
        letters = sorted(OutboxMessage.objects.values_list("template_code", flat=True))
        # Черновик поставщику не уходил — и об отмене ему не пишут.
        assert letters == ["flight_cancelled", "order_cancelled"]

    def test_ready_confirms_the_flight_to_the_client(
        self,
        flight_in_work: Flight,
        dispatcher: User,
        flight_templates: None,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        from comms.models import OutboxMessage
        from counterparties.models import Contact

        Contact.objects.create(
            client=flight_in_work.client, name="Мария Орлова", email="ops@client.test"
        )
        flight_in_work.service_orders.update(status=ServiceOrderStatus.CONFIRMED)

        with django_capture_on_commit_callbacks(execute=True):
            transitions.apply_transition(flight_in_work, "ready", actor=dispatcher)

        assert list(OutboxMessage.objects.values_list("template_code", flat=True)) == [
            "flight_confirmed"
        ]

    def test_generator_does_not_write_letters(
        self,
        flight: Flight,
        flight_templates: None,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        from audit.models import AuditSource
        from comms.models import OutboxMessage
        from counterparties.models import Contact

        Contact.objects.create(client=flight.client, name="Мария Орлова", email="ops@client.test")

        with django_capture_on_commit_callbacks(execute=True):
            transitions.apply_transition(
                flight, "cancel", reason_code="client_request", source=AuditSource.SEED
            )

        assert not OutboxMessage.objects.exists()


@pytest.mark.django_db
class TestReassignedRejection:
    """Отказ, вместо которого заказана замена, улажен (`DOMAIN.md § 5.1`)."""

    def test_replaced_rejection_does_not_block_readiness(
        self, flight_in_work: Flight, dispatcher: User
    ) -> None:
        rejected = flight_in_work.service_orders.get()
        ServiceOrder.objects.filter(pk=rejected.pk).update(status=ServiceOrderStatus.REJECTED)
        assert transitions.unmet_conditions(flight_in_work, "ready")

        replacement = _order(flight_in_work, "HND_BASIC", replaced_order=rejected)
        ServiceOrder.objects.filter(pk=replacement.pk).update(status=ServiceOrderStatus.CONFIRMED)

        assert transitions.unmet_conditions(flight_in_work, "ready") == []

    def test_unreplaced_rejection_still_blocks(
        self, flight_in_work: Flight, dispatcher: User
    ) -> None:
        flight_in_work.service_orders.update(status=ServiceOrderStatus.REJECTED)
        problems = transitions.unmet_conditions(flight_in_work, "ready")
        assert any("Отклонены" in problem for problem in problems)
