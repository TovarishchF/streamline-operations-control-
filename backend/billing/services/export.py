"""Выгрузка документов в PDF и XLSX `[ТЗ 3.4.1]` (`BACKEND.md § 8`).

Формирование на сервере: сумма в выгрузке обязана совпадать с суммой в API
и на экране до копейки. Считать её ещё раз в браузере значит завести второй
источник истины, который рано или поздно разойдётся с первым.

Файл кладётся в объектное хранилище, наружу отдаётся подписанная ссылка
со сроком жизни. При `DEMO_DATA=true` на документ наносится отметка `DEMO`
(ADR-008, `SPEC.md § 8.6`): выгрузка со стенда не должна быть неотличима
от настоящей.
"""

from __future__ import annotations

from decimal import Decimal
from io import BytesIO
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.template.loader import render_to_string
from django.utils.translation import gettext as _

from core import clock
from core.demo_marking import DEMO_NOTE
from core.exceptions import DomainError
from core.services import storage

if TYPE_CHECKING:
    from billing.models import Invoice, Quote

PDF = "pdf"
XLSX = "xlsx"

MIME = {
    PDF: "application/pdf",
    XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class ExportFormatNotSupported(DomainError):
    code = "VALIDATION_ERROR"


def _context(document: Quote | Invoice, *, kind: str) -> dict[str, Any]:
    """Данные печатной формы.

    Суммы берутся **из документа**, а не пересчитываются: документ уже
    посчитан и, если выставлен, неизменяем.
    """
    lines = [
        {
            "description": line.description,
            "airport": line.airport_icao,
            "quantity": line.quantity,
            "unit_price": line.unit_price_amount,
            "amount": line.amount,
            "vat": line.vat_amount,
        }
        for line in document.lines.all()
    ]

    return {
        "kind": kind,
        "title": _("Счёт") if kind == "invoice" else _("Котировка"),
        "number": document.number or _("черновик"),
        "issued_at": document.issued_at,
        "client": document.client.name,
        "client_legal": document.client.legal_name,
        "flight": document.flight.number,
        "route": f"{document.flight.dep_icao} → {document.flight.arr_icao}",
        "currency": document.currency,
        "lines": lines,
        "subtotal": document.subtotal_amount,
        "vat_total": document.vat_amount,
        "grand_total": document.total_amount,
        "due_date": getattr(document, "due_date", None),
        # Отметка стенда наносится по настройке, а не по признаку записи:
        # на стенде помечается всё, включая документы по введённым вручную
        # данным (`CLAUDE.md § 4`).
        "is_demo": bool(settings.DEMO_DATA),
        "generated_at": clock.now(),
    }


def _render_pdf(context: dict[str, Any]) -> bytes:
    from weasyprint import HTML

    html = render_to_string("billing/document.html", context)
    return bytes(HTML(string=html).write_pdf())


def _render_xlsx(context: dict[str, Any]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = str(context["title"])

    bold = Font(bold=True)
    row = 1

    if context["is_demo"]:
        # Текст пометки задан `SPEC.md § 8.6` и один на все выгрузки системы.
        sheet.cell(row=row, column=1, value=DEMO_NOTE).font = Font(
            bold=True, color="C0392B"
        )
        row += 2

    for label, value in (
        (str(context["title"]), context["number"]),
        (_("Клиент"), context["client_legal"] or context["client"]),
        (_("Рейс"), f"{context['flight']} {context['route']}"),
        (_("Валюта"), context["currency"]),
    ):
        sheet.cell(row=row, column=1, value=label).font = bold
        sheet.cell(row=row, column=2, value=value)
        row += 1

    row += 1
    headers = [
        _("Наименование"),
        _("Аэропорт"),
        _("Количество"),
        _("Цена"),
        _("Сумма"),
        _("НДС"),
    ]
    for column, title in enumerate(headers, start=1):
        cell = sheet.cell(row=row, column=column, value=title)
        cell.font = bold
        cell.alignment = Alignment(horizontal="center")
    row += 1

    for line in context["lines"]:
        # Суммы пишутся числом, а не строкой: в таблице их складывают,
        # а строку Excel складывать не станет. Точность Decimal
        # сохраняется приведением к float только на этом шаге — дальше
        # значение не участвует ни в каких расчётах системы.
        sheet.cell(row=row, column=1, value=line["description"])
        sheet.cell(row=row, column=2, value=line["airport"])
        sheet.cell(row=row, column=3, value=float(line["quantity"]))
        sheet.cell(row=row, column=4, value=float(line["unit_price"]))
        sheet.cell(row=row, column=5, value=float(line["amount"]))
        sheet.cell(row=row, column=6, value=float(line["vat"]))
        row += 1

    row += 1
    for label, value in (
        (_("Подытог"), context["subtotal"]),
        (_("НДС"), context["vat_total"]),
        (_("Итого"), context["grand_total"]),
    ):
        sheet.cell(row=row, column=4, value=label).font = bold
        cell = sheet.cell(row=row, column=5, value=float(value))
        cell.font = bold
        row += 1

    widths = {"A": 46, "B": 12, "C": 14, "D": 16, "E": 18, "F": 14}
    for letter, width in widths.items():
        sheet.column_dimensions[letter].width = width

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def export_document(*, document: Quote | Invoice, kind: str, export_format: str) -> str:
    """Формирует файл, кладёт в хранилище и возвращает подписанную ссылку."""
    if export_format not in MIME:
        raise ExportFormatNotSupported(
            _("Формат %(format)s не поддерживается. Доступны: PDF, XLSX.")
            % {"format": export_format},
            {"format": export_format},
        )

    context = _context(document, kind=kind)
    data = _render_pdf(context) if export_format == PDF else _render_xlsx(context)

    stamp = clock.now()
    safe_number = storage.safe_name(document.number or document.pk)
    key = f"exports/{stamp:%Y/%m}/{kind}-{safe_number}.{export_format}"
    storage.put_bytes(key=key, data=data, mime_type=MIME[export_format])

    return storage.presign_get(key=key, file_name=f"{safe_number}.{export_format}")


def totals_match(document: Quote | Invoice) -> bool:
    """Итог документа равен сумме округлённых строк (ADR-002 п. 3).

    Проверка для тестов выгрузки: приёмка M7 требует совпадения суммы
    в PDF, XLSX, API и на экране до копейки, а совпадать они могут только
    если итог не пересчитывается по дороге.
    """
    lines_total = sum((line.amount for line in document.lines.all()), Decimal(0))
    vat_total = sum((line.vat_amount for line in document.lines.all()), Decimal(0))
    return (
        document.subtotal_amount == lines_total
        and document.vat_amount == vat_total
        and document.total_amount == lines_total + vat_total
    )
