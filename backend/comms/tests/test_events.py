"""Сообщения и уведомления по доменным событиям `[ТЗ 3.5.1, 3.5.2]`.

Очередь исходящих, в которую никто ничего не кладёт, — работающая кнопка
над пустой таблицей. Здесь проверяется обратное: заказ услуги порождает
письмо поставщику, ответ поставщика — уведомление диспетчеру, выставленный
счёт — письмо клиенту.

Отдельно проверяется, что письмо не отменяет операцию: у поставщика может
не быть контактов, и заявка всё равно должна создаться.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from django.test import override_settings

from accounts.models import Role
from comms.models import MessageChannel, MessageTemplate, Notification, OutboxMessage
from core.clock import now
from counterparties.models import Contact
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import User
    from catalog.models import Service
    from counterparties.models import Client, Vendor
    from flights.models import Flight
    from orders.models import ServiceOrder

pytestmark = pytest.mark.django_db


@pytest.fixture
def vendor_contact(vendor_alpha: Vendor) -> Contact:
    return Contact.objects.create(
        vendor=vendor_alpha,
        name="Иван Петров",
        email="ops@vendor.test",
        locale="ru",
        is_primary=True,
    )


@pytest.fixture
def client_contact(client_alpha: Client) -> Contact:
    return Contact.objects.create(
        client=client_alpha,
        name="Мария Орлова",
        email="finance@client.test",
        locale="ru",
        is_primary=True,
    )


@pytest.fixture
def order_template(db: None) -> MessageTemplate:
    return MessageTemplate.objects.create(
        code="order_placed",
        channel=MessageChannel.EMAIL,
        subject_ru="Заявка {{order.id}}: {{service.name}}",
        subject_en="Order {{order.id}}: {{service.name}}",
        body_ru="Рейс {{flight.number}}, аэропорт {{order.airport}}.",
        body_en="Flight {{flight.number}}, airport {{order.airport}}.",
    )


@pytest.fixture
def invoice_template(db: None) -> MessageTemplate:
    return MessageTemplate.objects.create(
        code="invoice_issued",
        channel=MessageChannel.EMAIL,
        subject_ru="Счёт {{document.number}}",
        subject_en="Invoice {{document.number}}",
        body_ru="Сумма {{document.total}} {{document.currency}}.",
        body_en="Amount {{document.total}} {{document.currency}}.",
    )


# ─────────────────────────── Заявка поставщику ───────────────────────────


def place_order(
    *,
    capture: Any,
    flight: Flight,
    service: Service,
    vendor: Vendor,
    actor: User,
    quantity: str = "500.0000",
) -> ServiceOrder:
    """Заказ услуги с выполнением отложенных до фиксации действий.

    Письмо ставится в очередь через `transaction.on_commit`, а тест
    под `django_db` транзакцию откатывает — без захвата обработчик
    не выполнился бы, и проверка молча проходила бы на пустой очереди.
    """
    with capture(execute=True):
        return order_services.create_order(
            flight=flight,
            service=service,
            leg="departure",
            quantity=Decimal(quantity),
            vendor=vendor,
            attributes={},
            override_reason="",
            actor=actor,
        )


def test_placing_an_order_puts_a_letter_in_the_outbox(
    django_capture_on_commit_callbacks: Any,
    vendor_contact: Contact,
    order_template: MessageTemplate,
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
) -> None:
    """`ТЗ 3.2.2`: заявка уходит поставщику, а не остаётся на экране."""
    placed = place_order(
        capture=django_capture_on_commit_callbacks,
        flight=flight,
        service=fuel_service,
        vendor=vendor_alpha,
        actor=dispatcher,
    )

    message = OutboxMessage.objects.get(related_entity_id=placed.pk)
    assert message.template_code == "order_placed"
    assert message.to[0]["address"] == vendor_contact.email
    assert placed.pk in message.subject
    assert flight.number in message.body


def test_order_without_vendor_contacts_is_still_created(
    django_capture_on_commit_callbacks: Any,
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
    order_template: MessageTemplate,
) -> None:
    """Письмо — следствие события, а не его условие."""
    created = place_order(
        capture=django_capture_on_commit_callbacks,
        flight=flight,
        service=fuel_service,
        vendor=vendor_alpha,
        actor=dispatcher,
    )

    assert created.pk
    assert not OutboxMessage.objects.filter(related_entity_id=created.pk).exists()


def test_missing_template_does_not_break_the_order(
    django_capture_on_commit_callbacks: Any,
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
    vendor_contact: Contact,
) -> None:
    """Шаблона нет — заводят шаблон, а не отменяют состоявшуюся операцию."""
    created = place_order(
        capture=django_capture_on_commit_callbacks,
        flight=flight,
        service=fuel_service,
        vendor=vendor_alpha,
        actor=dispatcher,
    )
    assert created.pk
    assert OutboxMessage.objects.count() == 0


def test_letter_language_follows_the_contact(
    django_capture_on_commit_callbacks: Any,
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: Any,
    fuel_price: Any,
    dispatcher: User,
    order_template: MessageTemplate,
) -> None:
    Contact.objects.create(
        vendor=vendor_alpha, name="John Smith", email="ops@vendor.test", locale="en"
    )
    created = place_order(
        capture=django_capture_on_commit_callbacks,
        flight=flight,
        service=fuel_service,
        vendor=vendor_alpha,
        actor=dispatcher,
    )

    message = OutboxMessage.objects.get(related_entity_id=created.pk)
    assert message.body.startswith("Flight ")


# ─────────────────────── Ответ поставщика ───────────────────────


def test_confirmation_notifies_the_dispatchers(
    order: ServiceOrder, dispatcher: User, make_user: Callable[..., User]
) -> None:
    """`ТЗ 3.5.1`: оповещение о подтверждении услуги поставщиком."""
    watcher = make_user(Role.DISPATCHER, suffix="watcher")
    vendor_user = make_user(Role.VENDOR, suffix="v", vendor=order.vendor)

    transitions.apply_transition(order, "confirm", actor=vendor_user)

    notification = Notification.objects.get(user=watcher)
    assert notification.kind == "service_confirmed"
    assert order.flight.number in notification.title
    assert notification.link == f"/flights/{order.flight_id}/services"


def test_rejection_carries_the_reason(
    order: ServiceOrder, make_user: Callable[..., User]
) -> None:
    watcher = make_user(Role.DISPATCHER, suffix="watcher")
    vendor_user = make_user(Role.VENDOR, suffix="v", vendor=order.vendor)

    transitions.apply_transition(
        order, "reject", actor=vendor_user, comment="нет свободной техники"
    )

    notification = Notification.objects.get(user=watcher, kind="service_rejected")
    assert notification.body == "нет свободной техники"
    assert notification.severity == "warning"


def test_actor_is_not_notified_about_their_own_action(
    order: ServiceOrder, dispatcher: User
) -> None:
    """Сообщать человеку о том, что он сам сделал, — способ отучить читать."""
    transitions.apply_transition(order, "confirm", actor=dispatcher)
    assert not Notification.objects.filter(user=dispatcher).exists()


def test_late_confirmation_raises_an_sla_notification(
    order: ServiceOrder, make_user: Callable[..., User]
) -> None:
    from orders.models import ServiceOrder as Order

    watcher = make_user(Role.DISPATCHER, suffix="watcher")
    Order.objects.filter(pk=order.pk).update(sla_confirm_deadline=now() - timedelta(hours=2))
    order = Order.objects.get(pk=order.pk)

    vendor_user = make_user(Role.VENDOR, suffix="v", vendor=order.vendor)
    transitions.apply_transition(order, "confirm", actor=vendor_user)

    breach = Notification.objects.get(user=watcher, kind="sla_breach")
    assert breach.severity == "critical"


# ─────────────────────── Документы клиенту ───────────────────────


def complete(order: ServiceOrder, actor: User) -> ServiceOrder:
    """Доводит заявку до «Выполнена»: без этого в счёте нет строк."""
    from orders.models import ServiceOrder as Order
    from orders.services import orders as services

    transitions.apply_transition(order, "confirm", actor=actor)
    transitions.apply_transition(order, "begin", actor=actor)
    started = now()
    order = services.update_order(
        order=order,
        changes={
            "actual_start_at": started,
            "actual_end_at": started + timedelta(minutes=30),
            "actual_quantity": Decimal("1000.0000"),
        },
        actor=actor,
    )
    transitions.apply_transition(order, "finish", actor=actor)
    return Order.objects.get(pk=order.pk)


def test_issued_invoice_goes_to_the_client(
    django_capture_on_commit_callbacks: Any,
    flight: Flight,
    client_contact: Contact,
    invoice_template: MessageTemplate,
    order: ServiceOrder,
    make_user: Callable[..., User],
) -> None:
    from billing.services import documents

    finance = make_user(Role.FINANCE, suffix="events")
    complete(order, finance)

    invoice = documents.build_invoice(flight=flight, quote=None, actor=finance)
    with django_capture_on_commit_callbacks(execute=True):
        issued = documents.issue_invoice(invoice=invoice, actor=finance)

    message = OutboxMessage.objects.get(related_entity_type="invoice")
    assert message.related_entity_id == issued.pk
    assert message.to[0]["address"] == client_contact.email
    assert issued.number is not None
    assert issued.number in message.subject
    # Сумма в письме — та же, что в документе
    assert str(issued.total_amount.quantize(Decimal("0.01"))) in message.body


def test_draft_invoice_sends_nothing(
    django_capture_on_commit_callbacks: Any,
    flight: Flight,
    client_contact: Contact,
    invoice_template: MessageTemplate,
    order: ServiceOrder,
    make_user: Callable[..., User],
) -> None:
    """Письмо уходит на выставление, а не на подготовку черновика."""
    from billing.services import documents

    finance = make_user(Role.FINANCE, suffix="draft")
    complete(order, finance)

    with django_capture_on_commit_callbacks(execute=True):
        documents.build_invoice(flight=flight, quote=None, actor=finance)

    assert not OutboxMessage.objects.filter(related_entity_type="invoice").exists()


# ─────────────────────── Рейс ───────────────────────


def test_flight_status_change_notifies_dispatchers(
    flight: Flight, order: ServiceOrder, make_user: Callable[..., User]
) -> None:
    # Переход «взять в работу» требует хотя бы одной заявки на услугу —
    # её и даёт приспособление `order`.
    from flights.services import transitions as flight_transitions

    watcher = make_user(Role.DISPATCHER, suffix="fl")
    actor = make_user(Role.DISPATCHER, suffix="act")

    flight_transitions.apply_transition(flight, "start", actor=actor)

    notification = Notification.objects.get(user=watcher, kind="flight_status")
    assert flight.number in notification.title
    assert notification.link == f"/flights/{flight.pk}"


@override_settings(DEMO_DATA=True)
def test_notification_from_the_stand_is_marked(
    flight: Flight, order: ServiceOrder, make_user: Callable[..., User]
) -> None:
    """`CLAUDE.md § 4`: запись со стенда помечается как запись со стенда."""
    from flights.services import transitions as flight_transitions

    make_user(Role.DISPATCHER, suffix="demo")
    flight_transitions.apply_transition(
        flight, "start", actor=make_user(Role.MANAGER, suffix="act")
    )

    assert Notification.objects.filter(is_demo=True).exists()
