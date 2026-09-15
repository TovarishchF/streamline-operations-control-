"""Данные для подстановки в шаблоны `[ТЗ 3.5.2]`.

Один сборщик на предпросмотр и на настоящую отправку. Если предпросмотр
собирает данные иначе, он показывает не то письмо, которое уйдёт, —
а ради этого предпросмотр и существует.

Время подписывается зоной прямо в тексте: письмо читает человек в другой
стране, и «вылет в 12:40» без зоны — это не время (`CLAUDE.md § 3` п. 2).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from datetime import datetime

    from billing.models import Invoice, Quote
    from counterparties.models import VendorContract
    from flights.models import Flight
    from orders.models import ServiceOrder


def utc(value: datetime | None) -> str:
    """Момент времени для текста письма. Пусто — прочерк, а не «None»."""
    if value is None:
        return "—"
    return f"{value:%d.%m.%Y %H:%M}"


def operator_data() -> dict[str, Any]:
    from accounts.models import Organization

    organization = Organization.objects.filter(is_active=True).order_by("created_at").first()
    return {"name": organization.name if organization else "SOC"}


def flight_data(flight: Flight) -> dict[str, Any]:
    return {
        "number": flight.number,
        "route": f"{flight.dep_icao} → {flight.arr_icao}",
        "depIcao": flight.dep_icao,
        "arrIcao": flight.arr_icao,
        "std": utc(flight.std_utc),
        "sta": utc(flight.sta_utc),
        "aircraft": flight.aircraft.registration if flight.aircraft else "—",
        "status": flight.get_status_display(),
        "paxCount": flight.pax_count,
    }


def order_data(order: ServiceOrder) -> dict[str, Any]:
    return {
        "id": order.pk,
        "airport": order.airport_icao,
        "leg": order.get_leg_display(),
        "quantity": order.quantity,
        "confirmBy": utc(order.sla_confirm_deadline),
        "status": order.get_status_display(),
    }


def document_data(document: Quote | Invoice) -> dict[str, Any]:
    return {
        "number": document.number or "—",
        "total": document.total_amount,
        "currency": document.currency,
        "issuedAt": utc(document.issued_at),
        "dueDate": utc(getattr(document, "due_date", None)),
        "validUntil": utc(getattr(document, "valid_until", None)),
    }


def contract_data(contract: VendorContract) -> dict[str, Any]:
    return {
        "number": contract.number,
        "validFrom": utc(contract.valid_from),
        "validTo": utc(contract.valid_to),
        "status": contract.status,
    }


def for_flight(flight: Flight) -> dict[str, Any]:
    """Набор данных, достаточный для шаблонов уровня рейса.

    Используется предпросмотром: `SPEC.md § 8.2` требует показывать шаблон
    на выбранном рейсе, и шаблон заявки поставщику тоже должен
    на чём-то показаться — берётся первая заявка рейса.
    """
    data: dict[str, Any] = {
        "flight": flight_data(flight),
        "client": {"name": flight.client.name, "legalName": flight.client.legal_name},
        "operator": operator_data(),
        # Поля, которых у рейса нет: в предпросмотре они останутся видимыми
        # именами переменных, и это правильно — человек увидит, что данные
        # подставятся только при настоящей отправке.
    }

    order = flight.service_orders.select_related("service", "vendor").first()
    if order is not None:
        data["order"] = order_data(order)
        data["service"] = {"name": order.service.name_ru, "code": order.service.code}
        if order.vendor is not None:
            data["vendor"] = {"name": order.vendor.name}

    document = flight.invoices.order_by("-created_at").first()
    if document is not None:
        data["document"] = document_data(document)

    return data
