"""Операции над каталогом: цены поставщиков `[ТЗ 3.2.1]`.

Главное здесь — две вещи, которые нельзя оставлять сериализатору:

1. Периоды действия цены по одной тройке (поставщик, услуга, аэропорт)
   не пересекаются. Иначе на дату оказания подходят две цены, и выбор
   между ними произволен — а это разные суммы в счёте.
2. Поиск действующей цены на **дату оказания услуги**, а не на сегодня:
   заказ на послезавтра считается по цене, действующей послезавтра.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType
from catalog.models import VendorPrice
from core.exceptions import PriceNotFound
from core.money import Money

if TYPE_CHECKING:
    from datetime import datetime

    from accounts.models import User

# Коды надбавок из контракта (`openapi.yaml` Surcharge).
SURCHARGE_CODES = frozenset({"night", "weekend", "holiday", "urgent", "into_plane"})


class PriceOverlap(Exception):
    """Новый период пересекается с уже заведённым."""

    def __init__(self, existing: VendorPrice) -> None:
        super().__init__(
            f"Период пересекается с уже заведённой ценой от "
            f"{existing.valid_from:%d.%m.%Y} до {existing.valid_to:%d.%m.%Y}. "
            f"Закройте прежний период или выберите другие даты."
        )
        self.existing = existing


def find_overlap(
    *,
    vendor_id: str,
    service_id: str,
    airport_icao: str,
    valid_from: datetime,
    valid_to: datetime,
    exclude_id: str | None = None,
) -> VendorPrice | None:
    """Пересекающийся период по той же тройке.

    Периоды считаются полуоткрытыми: цена, заканчивающаяся ровно в момент
    начала следующей, пересечением не считается — это нормальная смена
    прайса с определённой даты.
    """
    queryset = VendorPrice.objects.filter(
        vendor_id=vendor_id,
        service_id=service_id,
        airport_icao=airport_icao.upper(),
        valid_from__lt=valid_to,
        valid_to__gt=valid_from,
    )
    if exclude_id:
        queryset = queryset.exclude(pk=exclude_id)
    return queryset.first()


@transaction.atomic
def create_price(
    *,
    vendor_id: str,
    service_id: str,
    airport_icao: str,
    amount: Decimal,
    currency: str,
    min_charge_amount: Decimal | None,
    valid_from: datetime,
    valid_to: datetime,
    surcharges: list[dict[str, Any]],
    actor: User,
) -> VendorPrice:
    """Заводит цену поставщика, не допуская наложения периодов."""
    icao = airport_icao.upper()
    overlap = find_overlap(
        vendor_id=vendor_id,
        service_id=service_id,
        airport_icao=icao,
        valid_from=valid_from,
        valid_to=valid_to,
    )
    if overlap is not None:
        raise PriceOverlap(overlap)

    price = VendorPrice.objects.create(
        vendor_id=vendor_id,
        service_id=service_id,
        airport_icao=icao,
        amount=amount,
        currency=currency,
        min_charge_amount=min_charge_amount,
        valid_from=valid_from,
        valid_to=valid_to,
        surcharges=surcharges,
    )

    audit.record(
        entity_type=AuditEntityType.VENDOR_PRICE,
        entity_id=price.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(price),
    )
    return price


def effective_price(
    *, vendor_id: str, service_id: str, airport_icao: str, moment: datetime
) -> VendorPrice | None:
    """Цена, действующая на указанный момент. `None`, если её нет."""
    return VendorPrice.objects.filter(
        vendor_id=vendor_id,
        service_id=service_id,
        airport_icao=airport_icao.upper(),
        valid_from__lte=moment,
        valid_to__gte=moment,
    ).first()


def candidates_at(
    *, service_id: str, airport_icao: str, moment: datetime
) -> list[VendorPrice]:
    """Все поставщики с действующей ценой на услугу в аэропорту.

    Основа проверки доступности (`SPEC.md § 5.2` п. 1) и таблицы сравнения
    кандидатов в мастере заказа.
    """
    return list(
        VendorPrice.objects.filter(
            service_id=service_id,
            airport_icao=airport_icao.upper(),
            valid_from__lte=moment,
            valid_to__gte=moment,
            vendor__is_active=True,
        )
        .select_related("vendor", "service")
        .order_by("amount")
    )


def purchase_cost(
    *,
    unit_amount: Decimal,
    currency: str,
    quantity: Decimal,
    surcharges: list[dict[str, Any]],
    min_charge_amount: Decimal | None,
) -> Money:
    """Закупочная стоимость заявки по формуле `DOMAIN.md § 7.1`.

    ```
    base       = price × quantity
    surcharges = Σ( percent → base × value/100 ; fixed → value )
    cost       = max(base + surcharges, minCharge ?? 0)
    ```

    Округление одно, на итоге (ADR-002): промежуточные величины идут
    с четырьмя знаками.
    """
    base = Money.of(unit_amount, currency).multiply(quantity)

    total = base
    for surcharge in surcharges:
        value = Decimal(str(surcharge["value"]))
        if surcharge["kind"] == "percent":
            total = total + base.percent(value)
        else:
            total = total + Money.of(value, currency)

    if min_charge_amount is not None:
        minimum = Money.of(min_charge_amount, currency)
        total = max(total, minimum)

    return total.rounded()


def price_not_found(*, airport_icao: str, service_code: str, moment: datetime) -> PriceNotFound:
    """Ошибка с текстом, по которому понятно, что делать (`BACKEND.md § 9`)."""
    return PriceNotFound(
        f"На {moment:%d.%m.%Y} нет действующей цены на услугу {service_code} "
        f"в аэропорту {airport_icao}. Заведите цену поставщика или выберите "
        f"другого поставщика.",
        {"airportIcao": airport_icao, "serviceCode": service_code},
    )
