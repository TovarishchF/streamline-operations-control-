"""Приспособления для тестов отчётности.

Отчёт агрегирует то, что уже произошло, поэтому набор здесь — не форма
ввода, а результат работы: выполненная заявка со снимком закупочной цены
и выставленный счёт. Собираются они сервисным слоем, а не прямой записью
в базу: статус заявки защищён автоматом (`CLAUDE.md § 3` п. 3), а номер
счёта выдаётся счётчиком, и подделать их значило бы проверять отчёт
на данных, которых система не породила бы.

Проходить через HTTP здесь незачем: создание заявки и выставление счёта
проверены своими тестами, а эти — про суммирование.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest

from billing.models import Invoice
from billing.services import documents
from catalog.models import (
    AircraftCategory,
    AircraftType,
    Airport,
    Service,
    ServiceCategory,
    ServiceUnit,
    VendorPrice,
)
from core.clock import now
from counterparties.models import PaymentMode, VendorContract
from fleet.models import Aircraft
from flights.models import Flight
from orders.models import ServiceOrder
from orders.services import orders as order_services
from orders.services import transitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from accounts.models import Organization, User
    from counterparties.models import Client, Vendor


@pytest.fixture
def airports(db: None) -> tuple[Airport, Airport]:
    departure = Airport.objects.create(
        icao="UUWW",
        iata="VKO",
        name_ru="Внуково",
        name_en="Vnukovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.5915,
        lon=37.2615,
    )
    arrival = Airport.objects.create(
        icao="ULLI",
        iata="LED",
        name_ru="Пулково",
        name_en="Pulkovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=59.8003,
        lon=30.2625,
    )
    return departure, arrival


@pytest.fixture
def aircraft(db: None) -> Aircraft:
    aircraft_type = AircraftType.objects.create(
        icao_type="GLF5",
        name_ru="Gulfstream G550",
        name_en="Gulfstream G550",
        category=AircraftCategory.HEAVY,
        seats=16,
        cruise_speed_kts=488,
        fuel_burn_kg_per_hour=1300,
        turnaround_min=60,
    )
    return Aircraft.objects.create(
        registration="RA-10300", type=aircraft_type, home_base_icao="UUWW"
    )


@pytest.fixture
def flight(
    organization: Organization,
    client_alpha: Client,
    aircraft: Aircraft,
    airports: tuple[Airport, Airport],
) -> Flight:
    """Рейс через двое суток: лидтайм заведомо соблюдён."""
    departure = now() + timedelta(days=2)
    return Flight.objects.create(
        organization=organization,
        number="SLG-7001",
        client=client_alpha,
        aircraft=aircraft,
        type="charter",
        dep_icao="UUWW",
        arr_icao="ULLI",
        std_utc=departure,
        sta_utc=departure + timedelta(hours=2),
        pax_count=8,
        billing_currency="RUB",
    )


@pytest.fixture
def fuel_service(db: None) -> Service:
    return Service.objects.create(
        code="FUEL-JETA1",
        category=ServiceCategory.FUEL,
        name_ru="Заправка Jet A-1",
        name_en="Jet A-1 refuelling",
        unit=ServiceUnit.LITRE,
        lead_time_h=4,
    )


@pytest.fixture
def contract(vendor_alpha: Vendor) -> VendorContract:
    return VendorContract.objects.create(
        vendor=vendor_alpha,
        number="ДГ-2026-7001",
        valid_from=now() - timedelta(days=90),
        valid_to=now() + timedelta(days=270),
        currency="RUB",
        payment_mode=PaymentMode.DEFERRED,
        payment_defer_days=14,
    )


@pytest.fixture
def fuel_price(
    vendor_alpha: Vendor, fuel_service: Service, airports: tuple[Airport, Airport]
) -> VendorPrice:
    return VendorPrice.objects.create(
        vendor=vendor_alpha,
        service=fuel_service,
        airport_icao="UUWW",
        amount=Decimal("70.0000"),
        currency="RUB",
        valid_from=now() - timedelta(days=30),
        valid_to=now() + timedelta(days=180),
    )


@pytest.fixture
def make_completed_order(
    dispatcher: User,
) -> Callable[..., ServiceOrder]:
    """Заявка, проведённая автоматом до «Выполнена».

    Переходы выполняются настоящим сервисом переходов: он же проставляет
    `completed_at` и признак нарушения SLA, по которым строятся отчёты.
    """

    def factory(
        *,
        flight: Flight,
        service: Service,
        vendor: Vendor,
        quantity: Decimal = Decimal("1000.0000"),
        actual_quantity: Decimal = Decimal("1200.0000"),
        breach_sla: bool = False,
    ) -> ServiceOrder:
        order = order_services.create_order(
            flight=flight,
            service=service,
            leg="departure",
            quantity=quantity,
            vendor=vendor,
            attributes={},
            override_reason="",
            actor=dispatcher,
        )
        if breach_sla:
            # Срок подтверждения в прошлом: переход `confirm` зафиксирует
            # нарушение сам, а не тест проставит его задним числом.
            ServiceOrder.objects.filter(pk=order.pk).update(
                sla_confirm_deadline=now() - timedelta(hours=3)
            )
            order = ServiceOrder.objects.get(pk=order.pk)

        transitions.apply_transition(order, "confirm", actor=dispatcher)
        transitions.apply_transition(order, "begin", actor=dispatcher)

        started = now()
        order = order_services.update_order(
            order=order,
            changes={
                "actual_start_at": started,
                "actual_end_at": started + timedelta(minutes=35),
                "actual_quantity": actual_quantity,
            },
            actor=dispatcher,
        )
        transitions.apply_transition(order, "finish", actor=dispatcher)
        return ServiceOrder.objects.get(pk=order.pk)

    return factory


@pytest.fixture
def completed_order(
    make_completed_order: Callable[..., ServiceOrder],
    flight: Flight,
    fuel_service: Service,
    vendor_alpha: Vendor,
    contract: VendorContract,
    fuel_price: VendorPrice,
) -> ServiceOrder:
    return make_completed_order(flight=flight, service=fuel_service, vendor=vendor_alpha)


@pytest.fixture
def issued_invoice(
    flight: Flight, completed_order: ServiceOrder, make_user: Callable[..., User]
) -> Invoice:
    """Выставленный счёт: в финансовый отчёт идёт выручка, а не черновик."""
    from accounts.models import Role

    finance = make_user(Role.FINANCE, suffix="reports")
    invoice = documents.build_invoice(flight=flight, quote=None, actor=finance)
    return documents.issue_invoice(invoice=invoice, actor=finance)


@pytest.fixture
def period(flight: Flight) -> dict[str, Any]:
    """Период, накрывающий рейс.

    Рейс в будущем, а окно по умолчанию — последние тридцать суток,
    поэтому период задаётся явно: иначе отчёт был бы пуст, и тест
    проверял бы пустоту, а не суммирование.
    """
    return {
        "from": (now() - timedelta(days=1)).date(),
        "to": (now() + timedelta(days=7)).date(),
    }


@pytest.fixture
def query(period: dict[str, Any]) -> dict[str, str]:
    """Тот же период строкой запроса."""
    return {
        "from": period["from"].isoformat(),
        "to": period["to"].isoformat(),
    }


@pytest.fixture
def empty_period() -> dict[str, Any]:
    """Период, в который заведомо ничего не попадает."""
    return {"from": date(2000, 1, 1), "to": date(2000, 1, 31)}
