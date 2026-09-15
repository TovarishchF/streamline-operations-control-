"""Шаблоны сообщений `[ТЗ 3.5.2]` (`SPEC.md § 8.2`).

Шаблон редактирует пользователь, и текст из формы исполнять нельзя.
Проверяется, что подстановка — это именно подстановка: ни тегов, ни
фильтров, ни доступа к методам объектов.

Отдельно проверяется пропуск переменной. Письмо с провалом посреди фразы
уходит поставщику и выглядит как сбой системы, поэтому пропуск обязан
быть виден в предпросмотре.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from comms.models import MessageTemplate
from comms.services import templates

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from flights.models import Flight

pytestmark = pytest.mark.django_db

URL = "/api/v1/message-templates"


# ─────────────────────────── Подстановка ───────────────────────────


def test_placeholder_is_replaced() -> None:
    text, missing = templates.render(
        "Рейс {{flight.number}} в {{flight.airport}}",
        {"flight": {"number": "SLG-1", "airport": "UUWW"}},
    )
    assert text == "Рейс SLG-1 в UUWW"
    assert missing == []


def test_missing_variable_stays_visible() -> None:
    """Пустая строка вместо имени превратила бы письмо в обрывок фразы."""
    text, missing = templates.render("Сумма {{document.total}}", {"document": {}})
    assert text == "Сумма {{document.total}}"
    assert missing == ["document.total"]


def test_money_keeps_its_precision() -> None:
    """`CLAUDE.md § 3` п. 1: сумма в письме — та же, что в документе."""
    text, _ = templates.render(
        "{{document.total}}", {"document": {"total": Decimal("1234.5600")}}
    )
    assert text == "1234.5600"


def test_template_language_is_not_a_template_language() -> None:
    """Текст из формы не исполняется: ни тегов, ни фильтров, ни вызовов."""
    payload = "{% load i18n %}{{ flight.number|upper }}{{ flight.save }}"
    text, missing = templates.render(payload, {"flight": {"number": "slg-1"}})

    # Тег не выполнен, фильтр не применён: выражение с `|` под шаблон
    # не подходит вовсе и остаётся текстом.
    assert text == payload
    # `flight.save` — синтаксически допустимая подстановка, значения для неё
    # нет, поэтому она попадает в пропуски. Метод при этом не вызван:
    # иначе в тексте оказался бы его результат.
    assert missing == ["flight.save"]


def test_unknown_path_does_not_walk_into_objects() -> None:
    """Обращение к методу объекта не открывает его вызов."""
    class Holder:
        def delete(self) -> str:
            return "удалено"

    text, missing = templates.render("{{obj.delete}}", {"obj": Holder()})
    # Метод подставился бы своим представлением, а не результатом вызова;
    # важно, что он не выполнен.
    assert "удалено" not in text
    assert missing == []


def test_variables_are_collected_from_both_languages() -> None:
    template = MessageTemplate(
        code="x",
        channel="email",
        subject_ru="{{a.one}}",
        subject_en="{{b.two}}",
        body_ru="{{c.three}}",
        body_en="{{a.one}}",
    )
    assert templates.variables_in(template) == ["a.one", "b.two", "c.three"]


# ─────────────────────────── Эндпоинты ───────────────────────────


def test_catalog_lists_templates(
    as_role: Callable[..., APIClient], template: MessageTemplate
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.get(URL)

    assert response.status_code == status.HTTP_200_OK
    row = response.json()["data"][0]
    assert row["code"] == template.code
    assert row["subject"]["ru"] and row["subject"]["en"]


def test_template_can_be_edited_by_admin(
    as_role: Callable[..., APIClient], template: MessageTemplate
) -> None:
    api = as_role(Role.ADMIN)
    response = api.patch(
        f"{URL}/{template.pk}",
        {
            "subject": {"ru": "Заявка {{order.id}}", "en": "Order {{order.id}}"},
            "body": {"ru": "Рейс {{flight.number}}", "en": "Flight {{flight.number}}"},
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    # Перечень переменных пересобран из нового текста
    assert response.json()["variables"] == ["flight.number", "order.id"]


def test_dispatcher_cannot_edit_templates(
    as_role: Callable[..., APIClient], template: MessageTemplate
) -> None:
    """`SPEC.md § 2.2`: правка шаблонов — отдельное право."""
    api = as_role(Role.DISPATCHER)
    response = api.patch(
        f"{URL}/{template.pk}",
        {"subject": {"ru": "x", "en": "x"}, "body": {"ru": "y", "en": "y"}},
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_edit_is_written_to_the_audit(
    as_role: Callable[..., APIClient], template: MessageTemplate
) -> None:
    from audit.models import AuditEntry

    api = as_role(Role.ADMIN)
    api.patch(
        f"{URL}/{template.pk}",
        {"subject": {"ru": "Новая тема", "en": "New subject"}, "body": {"ru": "a", "en": "b"}},
        format="json",
    )

    entry = AuditEntry.objects.filter(
        entity_type="message_template", entity_id=template.pk
    ).first()
    assert entry is not None
    assert entry.after is not None
    assert entry.after["subject_ru"] == "Новая тема"


# ─────────────────────────── Предпросмотр ───────────────────────────


def test_preview_renders_on_a_real_flight(
    as_role: Callable[..., APIClient],
    template: MessageTemplate,
    order: Any,
    flight: Flight,
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{template.pk}/preview", {"flightId": flight.pk}, format="json"
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert flight.number in body["body"]
    assert order.pk in body["subject"]
    assert body["missing"] == []


def test_preview_reports_variables_without_data(
    as_role: Callable[..., APIClient], flight: Flight
) -> None:
    """Пропуск обязан быть виден здесь, а не у получателя письма."""
    template = MessageTemplate.objects.create(
        code="claim",
        channel="email",
        subject_ru="Расхождение {{claim.difference}}",
        subject_en="Discrepancy {{claim.difference}}",
        body_ru="Основание: {{claim.reason}}",
        body_en="Grounds: {{claim.reason}}",
    )

    api = as_role(Role.DISPATCHER)
    body = api.post(
        f"{URL}/{template.pk}/preview", {"flightId": flight.pk}, format="json"
    ).json()

    assert body["missing"] == ["claim.difference", "claim.reason"]
    assert "{{claim.reason}}" in body["body"]


def test_preview_in_english(
    as_role: Callable[..., APIClient], template: MessageTemplate, order: Any, flight: Flight
) -> None:
    api = as_role(Role.DISPATCHER)
    body = api.post(
        f"{URL}/{template.pk}/preview",
        {"flightId": flight.pk, "locale": "en"},
        format="json",
    ).json()
    assert body["body"].startswith("Flight ")


def test_preview_on_missing_flight_is_not_found(
    as_role: Callable[..., APIClient], template: MessageTemplate
) -> None:
    api = as_role(Role.DISPATCHER)
    response = api.post(
        f"{URL}/{template.pk}/preview", {"flightId": "flt_00000000000000000000"}, format="json"
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


# ─────────────────────── Обязательный набор ───────────────────────


def test_reference_carries_every_required_template(db: None) -> None:
    """`SPEC.md § 8.2`: двенадцать шаблонов обязательны."""
    import json
    from pathlib import Path

    from django.conf import settings

    path = Path(settings.SHARED_DIR) / "reference" / "message-templates.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    codes = {item["code"] for item in payload["templates"]}

    required = {
        "flight_confirmed",
        "flight_rescheduled",
        "flight_cancelled",
        "quote_issued",
        "invoice_issued",
        "closing_documents",
        "order_placed",
        "order_changed",
        "order_cancelled",
        "order_deadline_reminder",
        "contract_expiring",
        "reconciliation_claim",
    }
    assert required <= codes, f"не хватает шаблонов: {sorted(required - codes)}"


def test_every_reference_template_has_both_languages(db: None) -> None:
    import json
    from pathlib import Path

    from django.conf import settings

    path = Path(settings.SHARED_DIR) / "reference" / "message-templates.json"
    payload = json.loads(path.read_text(encoding="utf-8"))

    for item in payload["templates"]:
        for field in ("subjectRu", "subjectEn", "bodyRu", "bodyEn"):
            assert item[field].strip(), f"{item['code']}: пустое поле {field}"
