"""Автоматические проверки заказа услуги `[ТЗ 3.2.2]` (`SPEC.md § 5.2`).

Порядок и блокирующий признак — оттуда же:

1. услуга доступна в аэропорту плеча (есть поставщик с действующей ценой);
2. у поставщика действующий контракт на дату оказания;
3. цена актуальна на дату оказания;
4. лидтайм соблюдён — иначе предупреждение;
5. для противообледенительной обработки — подсказка по погоде (ADR-029).

Провал 1–3 блокирует заказ. Провал 4–5 требует подтверждения с причиной,
и причина идёт в аудит.

Те же проверки показывает мастер заказа **до** отправки. Здесь они
выполняются ещё раз: показанное на экране полминуты назад могло устареть,
а решение о заказе принимает сервер.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from django.utils.translation import gettext as _

from catalog import services as catalog_services
from catalog.models import ServiceCategory
from core import clock
from counterparties import services as counterparty_services

if TYPE_CHECKING:
    from datetime import datetime

    from catalog.models import Service, VendorPrice
    from counterparties.models import VendorContract


@dataclass(frozen=True, slots=True)
class CheckResult:
    """Результат одной проверки. Форма совпадает с `ServiceCheckResult` контракта."""

    code: str
    passed: bool
    blocking: bool
    message: str


@dataclass(frozen=True, slots=True)
class OrderContext:
    """Всё, что проверки нашли по дороге, чтобы не искать это дважды."""

    checks: list[CheckResult]
    price: VendorPrice | None
    contract: VendorContract | None

    @property
    def blocking_failures(self) -> list[CheckResult]:
        return [check for check in self.checks if check.blocking and not check.passed]

    @property
    def soft_failures(self) -> list[CheckResult]:
        return [check for check in self.checks if not check.blocking and not check.passed]


def run(
    *,
    service: Service,
    airport_icao: str,
    vendor_id: str | None,
    service_moment: datetime,
) -> OrderContext:
    """Выполняет проверки и возвращает их вместе с найденными ценой и договором.

    `service_moment` — момент **оказания** услуги, а не текущий: заказ
    на послезавтра проверяется на послезавтра. Заказ по договору,
    истекающему завтра, оформлять нельзя.
    """
    checks: list[CheckResult] = []

    candidates = catalog_services.candidates_at(
        service_id=service.pk, airport_icao=airport_icao, moment=service_moment
    )
    checks.append(
        CheckResult(
            code="availability",
            passed=bool(candidates),
            blocking=True,
            message=(
                _("Услугу в %(airport)s оказывают поставщиков: %(count)d")
                % {"airport": airport_icao, "count": len(candidates)}
                if candidates
                else _(
                    "В аэропорту %(airport)s нет ни одного поставщика с действующей "
                    "ценой на эту услугу. Заведите цену поставщика."
                )
                % {"airport": airport_icao}
            ),
        )
    )

    contract = (
        counterparty_services.active_contract_for(vendor_id=vendor_id, moment=service_moment)
        if vendor_id
        else None
    )
    checks.append(
        CheckResult(
            code="contract_valid",
            passed=contract is not None,
            blocking=True,
            message=(
                _("Действует договор № %(number)s до %(date)s")
                % {"number": contract.number, "date": f"{contract.valid_to:%d.%m.%Y}"}
                if contract is not None
                else _(
                    "У поставщика нет договора, действующего на %(date)s. "
                    "Продлите договор или выберите другого поставщика."
                )
                % {"date": f"{service_moment:%d.%m.%Y}"}
            ),
        )
    )

    price = (
        catalog_services.effective_price(
            vendor_id=vendor_id,
            service_id=service.pk,
            airport_icao=airport_icao,
            moment=service_moment,
        )
        if vendor_id
        else None
    )
    checks.append(
        CheckResult(
            code="price_valid",
            passed=price is not None,
            blocking=True,
            message=(
                _("Цена действует на дату оказания")
                if price is not None
                else _(
                    "У этого поставщика нет действующей цены на %(date)s "
                    "в аэропорту %(airport)s."
                )
                % {"date": f"{service_moment:%d.%m.%Y}", "airport": airport_icao}
            ),
        )
    )

    hours_left = (service_moment - clock.now()).total_seconds() / 3600
    lead_time_met = hours_left >= service.lead_time_h
    checks.append(
        CheckResult(
            code="lead_time",
            passed=lead_time_met,
            blocking=False,
            message=(
                _("Лидтайм соблюдён: до оказания %(hours)d ч при норме %(required)d ч")
                % {"hours": int(hours_left), "required": service.lead_time_h}
                if lead_time_met
                else _(
                    "Лидтайм нарушен: до оказания %(hours)d ч при норме %(required)d ч. "
                    "Поставщик вправе отказать."
                )
                % {"hours": max(0, int(hours_left)), "required": service.lead_time_h}
            ),
        )
    )

    if service.requires_weather or service.category == ServiceCategory.DEICING:
        # ADR-029: подсказка диспетчеру. Решение принимает командир
        # воздушного судна, система его не подменяет.
        checks.append(
            CheckResult(
                code="weather",
                passed=True,
                blocking=False,
                message=_(
                    "Необходимость обработки определяет командир воздушного судна. "
                    "Система показывает условия, но не решает за него."
                ),
            )
        )

    return OrderContext(checks=checks, price=price, contract=contract)
