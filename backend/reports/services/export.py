"""Выгрузка отчётов `[ТЗ 3.6.3]` (`SPEC.md § 9.3`, `BACKEND.md § 8`).

Четыре формата: PDF (WeasyPrint), XLSX (openpyxl), CSV (стандартный
модуль), XML (lxml). Формирование на сервере, чтобы выгрузка большого
отчёта не зависела от браузера и чтобы файл можно было приложить к письму.

Данные берутся из построенного результата и не пересчитываются: то, что
человек видит на экране, и то, что уходит в файл, обязано совпадать.

Маркировка демонстрационного режима — по правилам `SPEC.md § 8.6`
с поправкой ADR-008: отчёт со стенда опознаётся как отчёт со стенда
в любом формате, включая CSV и XML, где водяной знак нарисовать негде.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from io import BytesIO, StringIO
from typing import TYPE_CHECKING, Any

from django.template.loader import render_to_string
from django.utils.translation import gettext as _

from core import clock
from core.demo_marking import DEMO_NOTE as DEMO_NOTE_TEXT
from core.exceptions import DomainError
from core.services import storage
from reports import definitions

if TYPE_CHECKING:
    from collections.abc import Callable

    from reports.definitions import Definition

PDF = "pdf"
XLSX = "xlsx"
CSV = "csv"
XML = "xml"

MIME = {
    PDF: "application/pdf",
    XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    CSV: "text/csv",
    XML: "application/xml",
}

# Пометка для форматов без оформления. Первой строкой, чтобы её нельзя
# было не заметить при любом способе открытия файла. Текст один на все
# выгрузки системы (`core.demo_marking`), здесь только переиспользуется.
DEMO_NOTE = DEMO_NOTE_TEXT

# Пространство имён внутренней схемы отчётов (ADR-032). Схема лежит
# в `shared/reference/xsd/soc-report-v1.xsd` и проверяется тестом.
XML_NAMESPACE = "urn:soc:report:1.0"


class ExportFormatNotSupported(DomainError):
    code = "VALIDATION_ERROR"


def _numeric(value: Any) -> float | None:
    """Значение для числовой ячейки XLSX.

    Суммы приходят десятичной строкой (`CLAUDE.md § 3` п. 1). В ячейку
    таблицы они кладутся числом, иначе их нельзя сложить средствами Excel.
    Приведение к float происходит только здесь, на границе выгрузки:
    дальше значение в расчётах системы не участвует.
    """
    if value is None or value == "":
        return None
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def _render_csv(spec: Definition, result: dict[str, Any]) -> bytes:
    buffer = StringIO()
    # Точка с запятой: Excel в русской локали разбирает по ней, а запятая
    # в нём же оказывается разделителем дробной части.
    writer = csv.writer(buffer, delimiter=";", quoting=csv.QUOTE_MINIMAL)

    if result["isDemo"]:
        writer.writerow([DEMO_NOTE])

    writer.writerow([column.ru for column in spec.columns])
    for row in result["rows"]:
        writer.writerow(["" if row.get(c.key) is None else row[c.key] for c in spec.columns])

    if result["totals"]:
        writer.writerow([])
        writer.writerow(
            [
                _("Итого") if index == 0 else result["totals"].get(column.key, "")
                for index, column in enumerate(spec.columns)
            ]
        )

    # BOM: без него Excel открывает файл в однобайтовой кодировке
    # и кириллица превращается в мусор.
    return buffer.getvalue().encode("utf-8-sig")


def _sheet_title(name: str) -> str:
    """Имя листа книги Excel.

    Excel запрещает в имени листа `[ ] : * ? / \\` и длину свыше 31 знака.
    Название «Финансовый: доходы, расходы, маржа» нарушает оба правила,
    и без очистки книга не сохраняется вовсе.
    """
    cleaned = name
    for forbidden in "[]:*?/\\":
        cleaned = cleaned.replace(forbidden, " ")
    return " ".join(cleaned.split())[:31].strip()


def render_xlsx(spec: Definition, result: dict[str, Any]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = _sheet_title(spec.ru)

    bold = Font(bold=True)
    row_index = 1

    if result["isDemo"]:
        sheet.cell(row=row_index, column=1, value=DEMO_NOTE).font = Font(
            bold=True, color="C0392B"
        )
        row_index += 2

    for index, column in enumerate(spec.columns, start=1):
        cell = sheet.cell(row=row_index, column=index, value=column.ru)
        cell.font = bold
        cell.alignment = Alignment(horizontal="center")
    header_row = row_index
    row_index += 1

    for row in result["rows"]:
        for index, column in enumerate(spec.columns, start=1):
            value = row.get(column.key)
            if column.type in ("money", "number", "percent"):
                sheet.cell(row=row_index, column=index, value=_numeric(value))
            else:
                sheet.cell(row=row_index, column=index, value=value)
        row_index += 1

    if result["totals"]:
        row_index += 1
        sheet.cell(row=row_index, column=1, value=str(_("Итого"))).font = bold
        for index, column in enumerate(spec.columns, start=1):
            if column.key in result["totals"]:
                cell = sheet.cell(
                    row=row_index, column=index, value=_numeric(result["totals"][column.key])
                )
                cell.font = bold

    sheet.freeze_panes = sheet.cell(row=header_row + 1, column=1)
    for index, column in enumerate(spec.columns, start=1):
        letter = sheet.cell(row=header_row, column=index).column_letter
        sheet.column_dimensions[letter].width = max(14, min(46, len(column.ru) + 6))

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _render_xml(
    spec: Definition, result: dict[str, Any], params: dict[str, Any] | None = None
) -> bytes:
    """XML по схеме `soc-report-v1.xsd` (ADR-032).

    Значения строк — `<Value key="…">`, а не элементы, названные по ключу
    колонки: схема одна на все семь отчётов, а наборы колонок у них разные.

    Ключ колонки, а не её заголовок: заголовки переводятся, а имя атрибута —
    часть схемы и от языка меняться не может. Заголовок уходит в `<Column>`
    текстом, там перевод уместен.
    """
    from lxml import etree

    root = etree.Element(
        f"{{{XML_NAMESPACE}}}Report",
        nsmap={None: XML_NAMESPACE},
        code=result["code"],
        generatedAt=result["generatedAt"],
        currency=result["currency"],
        demo="true" if result["isDemo"] else "false",
    )

    def child(parent: Any, tag: str, **attributes: str) -> Any:
        return etree.SubElement(parent, f"{{{XML_NAMESPACE}}}{tag}", **attributes)

    if result["isDemo"]:
        # Признак стенда в самом документе: получатель выгрузки
        # не должен гадать, настоящие ли это данные.
        child(root, "Note").text = DEMO_NOTE

    if params:
        parameters = child(root, "Parameters")
        for key, value in sorted(params.items()):
            child(parameters, "Parameter", key=key).text = str(value)

    columns = child(root, "Columns")
    for column in spec.columns:
        child(columns, "Column", key=column.key, type=column.type).text = column.ru

    rows = child(root, "Rows")
    for row in result["rows"]:
        element = child(rows, "Row")
        for column in spec.columns:
            value = row.get(column.key)
            if value is None:
                continue
            attributes = {"key": column.key}
            if column.type == "money":
                attributes["currency"] = _currency_of(row, result)
            child(element, "Value", **attributes).text = str(value)

    if result["totals"]:
        totals = child(root, "Totals")
        for column in spec.columns:
            if column.key not in result["totals"]:
                continue
            attributes = {"key": column.key}
            if column.type == "money":
                attributes["currency"] = result["currency"]
            child(totals, "Total", **attributes).text = str(result["totals"][column.key])

    return bytes(
        etree.tostring(root, xml_declaration=True, encoding="UTF-8", pretty_print=True)
    )


def _currency_of(row: dict[str, Any], result: dict[str, Any]) -> str:
    """Валюта денежной величины строки.

    Строки бывают в разных валютах: закупка у поставщика в EUR, счёт
    клиенту в RUB. Построитель помечает такие строки собственной валютой;
    где пометки нет, берётся валюта отчёта.
    """
    return str(row.get("currency") or result["currency"])


def _render_pdf(spec: Definition, result: dict[str, Any]) -> bytes:
    from weasyprint import HTML

    html = render_to_string(
        "reports/report.html",
        {
            "title": spec.ru,
            "columns": spec.columns,
            "rows": result["rows"],
            "totals": result["totals"],
            "generated_at": result["generatedAt"],
            "is_demo": result["isDemo"],
        },
    )
    return bytes(HTML(string=html).write_pdf())


# Общая подпись — две позиции. У XML есть третья, необязательная:
# раздел `<Parameters>` требует схема, и вызывается он отдельно.
RENDERERS: dict[str, Callable[[Definition, dict[str, Any]], bytes]] = {
    PDF: _render_pdf,
    XLSX: render_xlsx,
    CSV: _render_csv,
    XML: _render_xml,
}


@dataclass(frozen=True, slots=True)
class Export:
    """Собранный файл выгрузки в хранилище.

    Ключ нужен там, где файл идёт дальше по системе — например, вложением
    в письмо. Ссылка нужна там, где файл открывает человек. Возвращать
    только ссылку значило бы заставить вызывающего разбирать её обратно.
    """

    key: str
    url: str
    mime_type: str
    file_name: str


@dataclass(frozen=True, slots=True)
class Rendered:
    """Собранный файл до записи в хранилище."""

    data: bytes
    mime_type: str
    file_name: str


def render_report(
    *,
    code: str,
    result: dict[str, Any],
    export_format: str,
    params: dict[str, Any] | None = None,
) -> Rendered:
    """Собирает файл, не трогая хранилище.

    Отделено от записи ради рассылки по подписке: отчёт собирается один
    раз, а кладётся столько раз, сколько у подписки получателей — вложение
    привязано к своему письму, и один объект хранилища на два письма
    завести нельзя.
    """
    if export_format not in RENDERERS:
        raise ExportFormatNotSupported(
            _("Формат %(format)s не поддерживается. Доступны: PDF, XLSX, CSV, XML.")
            % {"format": export_format},
            {"format": export_format},
        )

    spec = definitions.definition(code)
    data = (
        _render_xml(spec, result, params)
        if export_format == XML
        else RENDERERS[export_format](spec, result)
    )
    return Rendered(
        data=data, mime_type=MIME[export_format], file_name=f"{code}.{export_format}"
    )


def store(*, rendered: Rendered, key: str) -> Export:
    """Кладёт собранный файл под заданным ключом."""
    storage.put_bytes(key=key, data=rendered.data, mime_type=rendered.mime_type)
    return Export(
        key=key,
        url=storage.presign_get(key=key, file_name=rendered.file_name),
        mime_type=rendered.mime_type,
        file_name=rendered.file_name,
    )


def export_report(
    *,
    code: str,
    result: dict[str, Any],
    export_format: str,
    params: dict[str, Any] | None = None,
) -> Export:
    """Формирует файл, кладёт в хранилище и возвращает подписанную ссылку.

    `params` попадают только в XML: схема `soc-report-v1` требует раздел
    `<Parameters>`, чтобы по выгруженному файлу было видно, за какой период
    и по какому отбору он построен. В остальных форматах это видно из имени
    файла и заголовка страницы.
    """
    rendered = render_report(
        code=code, result=result, export_format=export_format, params=params
    )
    stamp = clock.now()
    key = f"reports/{stamp:%Y/%m}/{code}-{stamp:%Y%m%d-%H%M%S}.{export_format}"
    return store(rendered=rendered, key=key)
