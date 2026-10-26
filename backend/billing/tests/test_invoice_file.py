"""Файл счёта поставщика для сверки `[ТЗ 3.4.2]`.

Шаблон и разбор проверяются вместе: шаблон, выданный системой и заполненный
человеком, обязан читаться. Ошибки разбора — с номерами строк по всему
файлу, а не по одной за попытку.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from datetime import UTC, datetime

import pytest
from openpyxl import Workbook, load_workbook

from billing.services import invoice_file
from billing.services.invoice_file import InvoiceFileError

TITLES = [column.title for column in invoice_file.COLUMNS]


def xlsx(rows: Sequence[Sequence[object]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def excel_moment(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    """Дата из ячейки Excel: пояса у неё нет, Excel его не хранит."""
    return datetime(year, month, day, hour, minute, tzinfo=UTC).replace(tzinfo=None)


def errors_of(name: str, content: bytes) -> list[str]:
    with pytest.raises(InvoiceFileError) as caught:
        invoice_file.parse(name, content)
    rows: list[str] = caught.value.details["rows"]
    return rows


# ─────────────────────────── Шаблон ───────────────────────────


def test_xlsx_template_reads_back_as_its_own_columns() -> None:
    """Пустой шаблон разбирается до «нет позиций», а не до «нет колонок»."""
    content, content_type, filename = invoice_file.template("xlsx")

    assert content_type == invoice_file.XLSX_CONTENT_TYPE
    assert filename.endswith(".xlsx")
    sheet = load_workbook(io.BytesIO(content)).worksheets[0]
    assert [cell.value for cell in sheet[1]] == TITLES
    assert errors_of(filename, content) == ["В файле нет ни одной позиции счёта"]


def test_xlsx_template_carries_an_instruction_sheet() -> None:
    content, _, _ = invoice_file.template("xlsx")
    workbook = load_workbook(io.BytesIO(content))

    assert len(workbook.worksheets) == 2
    texts = [cell.value for row in workbook.worksheets[1].iter_rows() for cell in row]
    for column in invoice_file.COLUMNS:
        assert column.hint in texts


def test_csv_template_opens_in_excel_by_columns() -> None:
    """BOM и точка с запятой: Excel с русской локалью иначе склеит колонки."""
    content, content_type, filename = invoice_file.template("csv")

    assert content_type.startswith("text/csv")
    assert content.startswith(b"\xef\xbb\xbf")
    assert content.decode("utf-8-sig").strip() == ";".join(TITLES)
    assert errors_of(filename, content) == ["В файле нет ни одной позиции счёта"]


# ─────────────────────────── Разбор ───────────────────────────


def test_filled_xlsx_becomes_an_import_payload() -> None:
    """Числа и даты Excel хранит своими типами — разбор принимает и их."""
    content = xlsx(
        [
            TITLES,
            [
                "А-1024",
                excel_moment(2026, 10, 20),
                "RUB",
                "uuww",
                excel_moment(2026, 10, 18, 14, 30),
                "FUEL-JETA1",
                1000,
                70.05,
                70050.5,
            ],
            [None, None, None, "UUWW", "18.10.2026 15:10", "GPU", "2", "4 500,00", "9000,00"],
        ]
    )

    payload = invoice_file.parse("счёт.xlsx", content)

    assert payload["number"] == "А-1024"
    assert payload["issuedAt"] == datetime(2026, 10, 20, tzinfo=UTC).isoformat()
    assert payload["currency"] == "RUB"
    first, second = payload["lines"]
    assert first == {
        "airportIcao": "UUWW",
        "serviceDate": datetime(2026, 10, 18, 14, 30, tzinfo=UTC).isoformat(),
        "serviceCode": "FUEL-JETA1",
        "quantity": "1000",
        "unitPrice": {"amount": "70.05", "currency": "RUB"},
        "amount": {"amount": "70050.5", "currency": "RUB"},
    }
    assert second["unitPrice"]["amount"] == "4500.00"
    assert second["serviceDate"] == datetime(2026, 10, 18, 15, 10, tzinfo=UTC).isoformat()


def test_csv_from_russian_excel_is_read() -> None:
    """Windows-1251, точка с запятой, запятая в дробях — как сохраняет Excel."""
    text = ";".join(TITLES) + "\r\n" + "Б-7;01.10.2026;USD;LFPB;30.09.2026;GPU;1;350,5;350,5\r\n"

    payload = invoice_file.parse("invoice.csv", text.encode("cp1251"))

    assert payload["number"] == "Б-7"
    assert payload["currency"] == "USD"
    assert payload["lines"][0]["amount"] == {"amount": "350.5", "currency": "USD"}


def test_csv_with_api_field_names_is_read() -> None:
    """Файл, выгруженный системой поставщика, может называть колонки полями API."""
    keys = [column.key for column in invoice_file.COLUMNS]
    text = (
        ",".join(keys) + "\n" + "V-1,2026-10-01,EUR,EGLF,2026-09-30T08:00:00Z,HANDLING,1,900,900\n"
    )

    payload = invoice_file.parse("export.csv", text.encode())

    assert payload["lines"][0]["serviceDate"] == "2026-09-30T08:00:00+00:00"


def test_missing_columns_are_named() -> None:
    content = xlsx([TITLES[:-1], ["А-1", "20.10.2026", "RUB", "UUWW", "18.10.2026", "X", 1, 1]])

    with pytest.raises(InvoiceFileError) as caught:
        invoice_file.parse("a.xlsx", content)

    assert caught.value.details["missingColumns"] == ["Сумма"]


def test_errors_are_collected_with_row_numbers() -> None:
    """Все ошибки файла сразу, с номером строки, как её видит человек в Excel."""
    content = xlsx(
        [
            TITLES,
            ["А-1", "20.10.2026", "RUB", "UUW", "18.10.2026", "FUEL", "1", "1", "1"],
            [None, None, None, "UUWW", "31.02.2026", "FUEL", "один", "1", "1"],
        ]
    )

    errors = errors_of("a.xlsx", content)

    assert errors[0].startswith("Строка 2: Аэропорт ИКАО")
    assert any(error.startswith("Строка 3: Дата услуги") for error in errors)
    assert any(error.startswith("Строка 3: Количество") for error in errors)


def test_header_is_required_in_the_first_row_only() -> None:
    content = xlsx(
        [
            TITLES,
            [None, "20.10.2026", None, "UUWW", "18.10.2026", "FUEL", "1", "1", "1"],
        ]
    )

    errors = errors_of("a.xlsx", content)

    assert "Строка 2: не заполнено поле «Номер счёта»" in errors
    assert "Строка 2: не заполнено поле «Валюта»" in errors


def test_two_invoices_in_one_file_are_refused() -> None:
    """Другой номер в середине файла — другой счёт, а не продолжение этого."""
    content = xlsx(
        [
            TITLES,
            ["А-1", "20.10.2026", "RUB", "UUWW", "18.10.2026", "FUEL", "1", "1", "1"],
            ["А-2", None, None, "UUWW", "18.10.2026", "FUEL", "1", "1", "1"],
        ]
    )

    errors = errors_of("a.xlsx", content)

    assert len(errors) == 1
    assert errors[0].startswith("Строка 3: «Номер счёта» А-2 не совпадает")


@pytest.mark.parametrize("name", ["invoice.pdf", "invoice.xls", "invoice"])
def test_other_formats_are_refused(name: str) -> None:
    with pytest.raises(InvoiceFileError, match="XLSX или CSV"):
        invoice_file.parse(name, b"%PDF-1.4")


def test_broken_xlsx_is_refused_with_a_message() -> None:
    with pytest.raises(InvoiceFileError, match="не читается"):
        invoice_file.parse("broken.xlsx", b"not a zip")
