"""Каталог отчётов `[ТЗ 3.6.1]` (`SPEC.md § 9.1`).

Семь обязательных отчётов из ТЗ. Восьмого без изменения ТЗ быть не может,
поэтому перечень закрыт, а не собирается из подключаемых модулей.

Определение отчёта — это его код, наименование на двух языках, параметры
и описание колонок. Колонки объявлены здесь, а не в построителе: по ним
собирается и таблица на экране, и заголовок выгрузки, и XML-схема.
Собирать их в трёх местах значит получить три разных набора.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

FLIGHTS_PERIOD = "flights_period"
SERVICES_RENDERED = "services_rendered"
FINANCIAL = "financial"
VENDORS = "vendors"
RECEIVABLES_PAYABLES = "receivables_payables"
SLA_BREACHES = "sla_breaches"
FLIGHT_AUDIT = "flight_audit"


@dataclass(frozen=True, slots=True)
class Parameter:
    key: str
    type: str
    required: bool


@dataclass(frozen=True, slots=True)
class Column:
    """Колонка отчёта.

    `type` определяет и выравнивание на экране, и формат ячейки в выгрузке:
    `money` идёт числом с двумя знаками, `percent` — долей, `date` — датой,
    а не строкой. Без этого в XLSX суммы оказываются текстом, и сложить
    их в таблице нельзя.
    """

    key: str
    ru: str
    en: str
    type: str = "string"


@dataclass(frozen=True, slots=True)
class Definition:
    code: str
    ru: str
    en: str
    parameters: list[Parameter]
    columns: list[Column]
    # Итоговая строка: по каким колонкам считать сумму. Для процентов
    # и дат суммы бессмысленны, поэтому перечисляются явно.
    totals: list[str] = field(default_factory=list)

    def to_contract(self) -> dict[str, Any]:
        """Форма `ReportDefinition` из `openapi.yaml`."""
        return {
            "code": self.code,
            "name": {"ru": self.ru, "en": self.en},
            "parameters": [
                {"key": p.key, "type": p.type, "required": p.required} for p in self.parameters
            ],
        }

    def columns_to_contract(self) -> list[dict[str, Any]]:
        return [
            {"key": c.key, "title": {"ru": c.ru, "en": c.en}, "type": c.type}
            for c in self.columns
        ]


PERIOD = [
    Parameter("from", "date", required=True),
    Parameter("to", "date", required=True),
]


DEFINITIONS: dict[str, Definition] = {
    FLIGHTS_PERIOD: Definition(
        code=FLIGHTS_PERIOD,
        ru="Рейсы за период",
        en="Flights for period",
        parameters=[*PERIOD, Parameter("clientId", "string", required=False)],
        columns=[
            Column("number", "Рейс", "Flight"),
            Column("client", "Клиент", "Client"),
            Column("aircraft", "Борт", "Aircraft"),
            Column("route", "Маршрут", "Route"),
            Column("std", "Вылет", "Departure", type="date"),
            Column("status", "Статус", "Status"),
            Column("services", "Услуг", "Services", type="number"),
        ],
        totals=["services"],
    ),
    SERVICES_RENDERED: Definition(
        code=SERVICES_RENDERED,
        ru="Оказанные услуги",
        en="Services rendered",
        parameters=[
            *PERIOD,
            Parameter("category", "string", required=False),
            Parameter("vendorId", "string", required=False),
        ],
        columns=[
            Column("category", "Категория", "Category"),
            Column("service", "Услуга", "Service"),
            Column("vendor", "Поставщик", "Vendor"),
            Column("airport", "Аэропорт", "Airport"),
            Column("count", "Заявок", "Orders", type="number"),
            Column("quantity", "Количество", "Quantity", type="number"),
            Column("cost", "Закупка", "Cost", type="money"),
        ],
        totals=["count", "cost"],
    ),
    FINANCIAL: Definition(
        code=FINANCIAL,
        ru="Финансовый: доходы, расходы, маржа",
        en="Financial: revenue, cost, margin",
        parameters=[*PERIOD, Parameter("clientId", "string", required=False)],
        columns=[
            Column("flight", "Рейс", "Flight"),
            Column("client", "Клиент", "Client"),
            Column("revenue", "Выручка", "Revenue", type="money"),
            Column("cost", "Закупка", "Cost", type="money"),
            Column("margin", "Маржа", "Margin", type="money"),
            Column("marginPercent", "Маржа, %", "Margin, %", type="percent"),
        ],
        totals=["revenue", "cost", "margin"],
    ),
    VENDORS: Definition(
        code=VENDORS,
        ru="Поставщики: объём, качество, нарушения",
        en="Vendors: volume, quality, breaches",
        parameters=PERIOD,
        columns=[
            Column("vendor", "Поставщик", "Vendor"),
            Column("orders", "Заявок", "Orders", type="number"),
            Column("completed", "Выполнено", "Completed", type="number"),
            Column("rejected", "Отклонено", "Rejected", type="number"),
            Column("slaBreaches", "Нарушений SLA", "SLA breaches", type="number"),
            Column("onTimeRate", "Подтверждено в срок", "Confirmed on time", type="percent"),
            Column("volume", "Объём закупки", "Purchase volume", type="money"),
        ],
        totals=["orders", "completed", "rejected", "slaBreaches", "volume"],
    ),
    RECEIVABLES_PAYABLES: Definition(
        code=RECEIVABLES_PAYABLES,
        ru="Дебиторская и кредиторская задолженность",
        en="Receivables and payables",
        parameters=[Parameter("asOf", "date", required=False)],
        columns=[
            Column("counterparty", "Контрагент", "Counterparty"),
            Column("kind", "Тип", "Kind"),
            Column("document", "Документ", "Document"),
            Column("dueDate", "Срок", "Due date", type="date"),
            Column("bucket", "Корзина", "Bucket"),
            Column("amount", "Сумма", "Amount", type="money"),
        ],
        totals=["amount"],
    ),
    SLA_BREACHES: Definition(
        code=SLA_BREACHES,
        ru="Реестр нарушений SLA",
        en="SLA breach register",
        parameters=[*PERIOD, Parameter("vendorId", "string", required=False)],
        columns=[
            Column("flight", "Рейс", "Flight"),
            Column("service", "Услуга", "Service"),
            Column("vendor", "Поставщик", "Vendor"),
            Column("deadline", "Срок подтверждения", "Confirm deadline", type="date"),
            Column("confirmedAt", "Подтверждено", "Confirmed at", type="date"),
            Column("lateHours", "Опоздание, ч", "Late, hours", type="number"),
        ],
        totals=["lateHours"],
    ),
    FLIGHT_AUDIT: Definition(
        code=FLIGHT_AUDIT,
        ru="Журнал изменений рейсов",
        en="Flight change log",
        parameters=[*PERIOD, Parameter("flightId", "string", required=False)],
        columns=[
            Column("ts", "Время", "Time", type="date"),
            Column("actor", "Кто", "Actor"),
            Column("entity", "Объект", "Entity"),
            Column("action", "Действие", "Action"),
            Column("comment", "Комментарий", "Comment"),
        ],
    ),
}


def definition(code: str) -> Definition:
    found = DEFINITIONS.get(code)
    if found is None:
        raise KeyError(code)
    return found
