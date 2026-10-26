"""Экран внешних подключений `[ТЗ 4.2]` (ADR-039).

Показываются только работающие подключения, и состояние у них — по журналу
настоящих обменов. Записи заглушек, сделанные до ADR-039, настоящими
обменами не были: ни в состоянии, ни в журнале их нет.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from integrations.fx.live import Provider as FxProvider
from integrations.models import ExchangeStatus, IntegrationLog, IntegrationMode

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

URL = "/api/v1/integrations"
RECORDED = Path(__file__).parent / "fixtures" / "cbr-2026-09-11.xml"


@pytest.fixture
def connected(settings: Any) -> None:
    # MSGR включён настройкой, но адаптера у него нет — работающим он не считается
    settings.INTEGRATIONS_ENABLED = ["FX", "SMTP", "MSGR"]


def _log(code: str, *, mode: str = IntegrationMode.LIVE, ok: bool = True) -> IntegrationLog:
    return IntegrationLog.objects.create(
        code=code,
        mode=mode,
        operation="rates_on_date",
        status=ExchangeStatus.OK if ok else ExchangeStatus.ERROR,
        error="" if ok else "URLError: timed out",
    )


@pytest.mark.usefixtures("connected")
def test_only_working_connections_are_listed(as_role: Callable[..., APIClient]) -> None:
    rows = as_role(Role.ADMIN).get(URL).json()["data"]

    assert [row["code"] for row in rows] == ["FX", "SMTP"]
    assert rows[0]["name"]["ru"] == "Курсы валют ЦБ РФ"
    # Обменов ещё не было — состояние неизвестно, а не «исправно»
    assert rows[0]["healthy"] is None
    assert set(rows[0]) == {"code", "name", "healthy", "lastCheckAt", "lastSuccessAt"}


@pytest.mark.usefixtures("connected")
def test_health_follows_the_last_real_exchange(as_role: Callable[..., APIClient]) -> None:
    _log("FX", ok=True)
    _log("FX", ok=False)
    # Запись заглушки до ADR-039 — не обмен и на состояние не влияет
    _log("FX", mode=IntegrationMode.STUB, ok=True)

    fx = as_role(Role.ADMIN).get(URL).json()["data"][0]

    assert fx["healthy"] is False
    assert fx["lastSuccessAt"] is not None


@pytest.mark.usefixtures("connected")
def test_check_calls_the_real_system_and_logs_it(
    as_role: Callable[..., APIClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = RECORDED.read_bytes().decode("windows-1251")
    monkeypatch.setattr(FxProvider, "_fetch", lambda self, url: payload)

    response = as_role(Role.ADMIN).post(f"{URL}/FX/test")

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["success"] is True
    entry = IntegrationLog.objects.get(code="FX")
    assert entry.operation == "check"
    assert entry.mode == IntegrationMode.LIVE


@pytest.mark.usefixtures("connected")
def test_failed_check_is_a_result_not_an_error(
    as_role: Callable[..., APIClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreachable(self: FxProvider, url: str) -> str:
        raise OSError("сеть недоступна")

    monkeypatch.setattr(FxProvider, "_fetch", unreachable)

    response = as_role(Role.ADMIN).post(f"{URL}/FX/test")

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["success"] is False
    assert "сеть недоступна" in response.json()["message"]
    assert IntegrationLog.objects.get(code="FX").status == ExchangeStatus.ERROR


@pytest.mark.usefixtures("connected")
def test_connection_without_adapter_cannot_be_checked(
    as_role: Callable[..., APIClient],
) -> None:
    response = as_role(Role.ADMIN).post(f"{URL}/MSGR/test")
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_log_shows_only_real_exchanges(as_role: Callable[..., APIClient]) -> None:
    _log("FX")
    _log("SMTP", ok=False)
    _log("FX", mode=IntegrationMode.STUB)

    rows = as_role(Role.ADMIN).get(f"{URL}/logs").json()["data"]

    assert sorted(row["code"] for row in rows) == ["FX", "SMTP"]
    failed = next(row for row in rows if row["code"] == "SMTP")
    assert failed["success"] is False
    assert failed["error"] == "URLError: timed out"
    assert failed["httpStatus"] is None
    assert "mode" not in failed


def test_log_can_be_filtered_by_connection(as_role: Callable[..., APIClient]) -> None:
    _log("FX")
    _log("SMTP")

    rows = as_role(Role.ADMIN).get(f"{URL}/logs?code=SMTP").json()["data"]

    assert [row["code"] for row in rows] == ["SMTP"]


@pytest.mark.parametrize("role", [Role.DISPATCHER, Role.FINANCE, Role.MANAGER])
def test_connections_are_for_the_administrator_only(
    as_role: Callable[..., APIClient], role: str
) -> None:
    api = as_role(role)
    assert api.get(URL).status_code == status.HTTP_403_FORBIDDEN
    assert api.get(f"{URL}/logs").status_code == status.HTTP_403_FORBIDDEN
