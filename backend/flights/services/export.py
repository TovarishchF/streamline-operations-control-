"""Выгрузка суточного плана `[ТЗ 3.1.1]` (`BACKEND.md § 8`).

Выгружается то, что человек видит на экране: тот же отбор, те же строки,
тот же порядок. Отдельный набор фильтров у выгрузки означал бы файл,
не совпадающий с таблицей, — а именно за этим её и открывают.

Формат один — XLSX: расписание уносят в таблицу, чтобы считать и сводить.
PDF расписания на двадцать рейсов не нужен никому, а четыре формата здесь
были бы четырьмя способами получить одно и то же.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from core import clock
from core.demo_marking import is_demo as demo_mode
from reports.definitions import Column, Definition
from reports.services import export as report_export

if TYPE_CHECKING:
    from django.db.models import QuerySet

    from flights.models import Flight

# Колонки выгрузки повторяют таблицу суточного плана. Заведены здесь,
# а не в каталоге отчётов: это выгрузка экрана, а не отчёт, и появляться
# в списке отчётов ей незачем.
SCHEDULE = Definition(
    code="schedule",
    ru="Суточный план",
    en="Flight schedule",
    parameters=[],
    columns=[
        Column("number", "Рейс", "Flight"),
        Column("client", "Клиент", "Client"),
        Column("aircraft", "Борт", "Aircraft"),
        Column("type", "Тип", "Type"),
        Column("depIcao", "Вылет", "From"),
        Column("std", "Время вылета", "Departure", type="date"),
        Column("arrIcao", "Прилёт", "To"),
        Column("sta", "Время прилёта", "Arrival", type="date"),
        Column("paxCount", "Пассажиров", "Pax", type="number"),
        Column("status", "Статус", "Status"),
        Column("services", "Услуг", "Services", type="number"),
    ],
    totals=["paxCount", "services"],
)


def rows_for(flights: QuerySet[Flight]) -> list[dict[str, Any]]:
    """Строки выгрузки из выборки рейсов."""
    from django.db.models import Count

    prepared = flights.select_related("client", "aircraft").annotate(
        service_count=Count("service_orders")
    )
    return [
        {
            "number": flight.number,
            "client": flight.client.name,
            "aircraft": flight.aircraft.registration if flight.aircraft else None,
            "type": flight.get_type_display(),
            "depIcao": flight.dep_icao,
            "std": flight.std_utc.isoformat(),
            "arrIcao": flight.arr_icao,
            "sta": flight.sta_utc.isoformat() if flight.sta_utc else None,
            "paxCount": flight.pax_count,
            "status": flight.get_status_display(),
            "services": flight.service_count,
        }
        for flight in prepared
    ]


def export_schedule(flights: QuerySet[Flight]) -> report_export.Export:
    """Собирает книгу и кладёт её в хранилище.

    Возвращается подписанная ссылка со сроком жизни — тем же способом,
    что и остальные выгрузки системы.
    """
    rows = rows_for(flights)
    result: dict[str, Any] = {
        "code": SCHEDULE.code,
        "generatedAt": clock.now().isoformat(),
        "currency": "RUB",
        # Выгрузка со стенда помечается как выгрузка со стенда
        # (`SPEC.md § 8.6`).
        "isDemo": demo_mode(),
        "columns": SCHEDULE.columns_to_contract(),
        "rows": rows,
        "totals": report_export_totals(rows),
    }

    rendered = report_export.Rendered(
        data=report_export.render_xlsx(SCHEDULE, result),
        mime_type=report_export.MIME[report_export.XLSX],
        file_name="schedule.xlsx",
    )
    stamp = clock.now()
    key = f"exports/{stamp:%Y/%m}/schedule-{stamp:%Y%m%d-%H%M%S}.xlsx"
    return report_export.store(rendered=rendered, key=key)


def report_export_totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Итоги по объявленным колонкам.

    Считаются по тем же строкам, что уходят в файл: «итого» обязано
    сходиться с колонкой (ADR-002 п. 3).
    """
    from reports.services.builders import totals_for

    return totals_for(SCHEDULE, rows)
