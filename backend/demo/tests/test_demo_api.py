"""Управление демонстрационным набором через интерфейс `[ТЗ этап 2]`.

Главное здесь — не генерация (её проверяют тесты команды), а то, что
кнопка не открывает лазейку: в боевом режиме действие запрещено, и запрет
стоит на самом эндпоинте, а не только в команде.

Второе — очистка удаляет **только** демонстрационные записи (ADR-016).
Кнопка, которая заодно уносит настоящие данные, хуже отсутствующей кнопки.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from django.test import override_settings
from rest_framework import status

from accounts.models import Role
from counterparties.models import Client

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from accounts.models import Organization

pytestmark = pytest.mark.django_db

SEED_URL = "/api/v1/demo/seed"
RESET_URL = "/api/v1/demo/reset"
PURGE_URL = "/api/v1/demo/purge"


def idempotent(key: str = "demo-key-000001") -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture
def reference(db: None) -> None:
    """Минимальные справочные данные: без них генератору не на что опереться."""
    from catalog.models import Airport

    Airport.objects.create(
        icao="UUWW",
        iata="VKO",
        name_ru="Внуково",
        name_en="Vnukovo",
        country="RU",
        timezone="Europe/Moscow",
        lat=55.5915,
        lon=37.2615,
    )


# ─────────────────────────── Режим ───────────────────────────


@pytest.mark.parametrize("url", [SEED_URL, RESET_URL, PURGE_URL])
def test_refused_in_production_mode(
    as_role: Callable[..., APIClient], url: str
) -> None:
    """`CLAUDE.md § 4`: придуманные контрагенты в боевой базе недопустимы."""
    api = as_role(Role.ADMIN)
    response = api.post(url, {}, format="json", headers=idempotent(f"prod-{len(url)}-x"))

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.json()["error"]["code"] == "DEMO_ONLY_OPERATION"


@override_settings(DEMO_DATA=True)
@pytest.mark.parametrize("url", [SEED_URL, RESET_URL, PURGE_URL])
def test_only_administrator_may_touch_the_stand(
    as_role: Callable[..., APIClient], url: str
) -> None:
    """Кнопка «Очистить» убирает со стенда всё, что показывают заказчику."""
    api = as_role(Role.DISPATCHER)
    response = api.post(url, {}, format="json", headers=idempotent(f"disp-{len(url)}-x"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


@override_settings(DEMO_DATA=True)
def test_idempotency_key_is_required(as_role: Callable[..., APIClient]) -> None:
    """Повторное нажатие не должно генерировать второй набор."""
    api = as_role(Role.ADMIN)
    assert api.post(PURGE_URL, {}, format="json").status_code == (
        status.HTTP_400_BAD_REQUEST
    )


# ─────────────────────────── Генерация ───────────────────────────


@override_settings(DEMO_DATA=True)
def test_generation_reports_what_it_created(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    api = as_role(Role.ADMIN)
    response = api.post(SEED_URL, {"seed": 20260913}, format="json", headers=idempotent())

    assert response.status_code == status.HTTP_200_OK, response.data
    body = response.json()
    assert body["action"] == "seed"
    assert body["counts"]["клиенты"] > 0
    assert body["counts"]["поставщики"] > 0


@override_settings(DEMO_DATA=True)
def test_generated_records_are_marked_as_the_stand(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    """Каждая запись несёт `is_demo` и `synthetic` (`CLAUDE.md § 4`)."""
    api = as_role(Role.ADMIN)
    api.post(SEED_URL, {}, format="json", headers=idempotent("mark-000001"))

    generated = Client.objects.exclude(name="Авиалинии Северного Ветра")
    assert generated.exists()
    for client in generated:
        assert client.is_demo is True
        assert client.data_source == "synthetic"


@override_settings(DEMO_DATA=True)
def test_generation_without_reference_data_explains_itself(
    as_role: Callable[..., APIClient],
) -> None:
    """Молчаливый успех с пустым набором выглядел бы как поломка стенда."""
    api = as_role(Role.ADMIN)
    response = api.post(SEED_URL, {}, format="json", headers=idempotent("noref-00001"))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "seed-reference" in response.json()["error"]["message"]


@override_settings(DEMO_DATA=True)
def test_same_seed_gives_the_same_set(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    """Снимки экранов и разговор с заказчиком должны воспроизводиться."""
    api = as_role(Role.ADMIN)
    api.post(SEED_URL, {"seed": 777}, format="json", headers=idempotent("det-0000001"))
    first = sorted(
        Client.objects.values_list("name", flat=True)
    )

    api.post(RESET_URL, {"seed": 777}, format="json", headers=idempotent("det-0000002"))
    second = sorted(Client.objects.values_list("name", flat=True))

    assert first == second


# ─────────────────────────── Очистка ───────────────────────────


@override_settings(DEMO_DATA=True)
def test_purge_removes_only_demo_records(
    as_role: Callable[..., APIClient],
    reference: None,
    organization: Organization,
) -> None:
    """ADR-016: настоящая запись на стенде переживает очистку."""
    real = Client.objects.create(
        organization=organization, name="Настоящий Клиент", is_demo=False
    )

    api = as_role(Role.ADMIN)
    api.post(SEED_URL, {}, format="json", headers=idempotent("purge-0001"))
    response = api.post(PURGE_URL, {}, format="json", headers=idempotent("purge-0002"))

    assert response.status_code == status.HTTP_200_OK, response.data
    assert Client.objects.filter(pk=real.pk).exists()
    assert not Client.objects.filter(is_demo=True).exists()


@override_settings(DEMO_DATA=True)
def test_purge_says_the_audit_stays(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    """Администратор вправе знать, что именно не удалилось."""
    api = as_role(Role.ADMIN)
    response = api.post(PURGE_URL, {}, format="json", headers=idempotent("purge-0003"))

    assert response.json()["action"] == "purge"
    assert "журнал" in response.json()["message"].lower()


@override_settings(DEMO_DATA=True)
def test_audit_entries_survive_the_purge(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    """`BACKEND.md § 3.9`: таблица аудита только пополняется."""
    from audit.models import AuditEntry

    api = as_role(Role.ADMIN)
    api.post(SEED_URL, {}, format="json", headers=idempotent("audit-0001"))
    before = AuditEntry.objects.count()
    assert before > 0

    api.post(PURGE_URL, {}, format="json", headers=idempotent("audit-0002"))
    assert AuditEntry.objects.count() >= before


# ─────────────────────────── Пересоздание ───────────────────────────


@override_settings(DEMO_DATA=True)
def test_reset_replaces_the_set(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    api = as_role(Role.ADMIN)
    api.post(SEED_URL, {}, format="json", headers=idempotent("reset-0001"))
    demo_clients = Client.objects.filter(is_demo=True).count()

    response = api.post(RESET_URL, {}, format="json", headers=idempotent("reset-0002"))

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["action"] == "reset"
    # Набор тот же по объёму, а не удвоенный
    assert Client.objects.filter(is_demo=True).count() == demo_clients


@override_settings(DEMO_DATA=True)
def test_repeating_the_same_key_does_not_generate_twice(
    as_role: Callable[..., APIClient], reference: None
) -> None:
    """ADR-018: повторное нажатие кнопки возвращает первый ответ."""
    api = as_role(Role.ADMIN)
    first: Any = api.post(SEED_URL, {}, format="json", headers=idempotent("twice-0001"))
    second: Any = api.post(SEED_URL, {}, format="json", headers=idempotent("twice-0001"))

    assert first.json() == second.json()
