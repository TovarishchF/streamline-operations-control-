"""Согласованность контракта, автоматов и настроек.

ADR-015: `shared/state-machines/*.json` — источник истины для обеих сторон.
Расхождение определения автомата между сервером, клиентом и контрактом —
частый и дорогой баг; эти тесты превращают его в падение сборки.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
CONTRACT = REPO_ROOT / "openapi.yaml"
MACHINES = REPO_ROOT / "shared" / "state-machines"


@pytest.fixture(scope="module")
def contract() -> dict[str, Any]:
    with CONTRACT.open(encoding="utf-8") as handle:
        return cast(dict[str, Any], yaml.safe_load(handle))


def _machine(name: str) -> dict[str, Any]:
    with (MACHINES / name).open(encoding="utf-8") as handle:
        return cast(dict[str, Any], json.load(handle))


# ─────────────────────── Контракт против автоматов ───────────────────────


def test_flight_status_enum_matches_state_machine(contract: dict[str, Any]) -> None:
    """Статусы рейса в контракте совпадают с состояниями автомата."""
    contract_states = set(contract["components"]["schemas"]["FlightStatus"]["enum"])
    machine_states = set(_machine("flight.json")["states"])
    assert contract_states == machine_states, (
        f"расхождение статусов рейса: только в контракте "
        f"{contract_states - machine_states}, только в автомате "
        f"{machine_states - contract_states}"
    )


def test_flight_transitions_match_state_machine(contract: dict[str, Any]) -> None:
    contract_transitions = set(contract["components"]["schemas"]["FlightTransition"]["enum"])
    machine_transitions = {t["name"] for t in _machine("flight.json")["transitions"]}
    assert contract_transitions == machine_transitions


def test_service_order_status_enum_matches_state_machine(contract: dict[str, Any]) -> None:
    contract_states = set(contract["components"]["schemas"]["ServiceOrderStatus"]["enum"])
    machine_states = set(_machine("service-order.json")["states"])
    assert contract_states == machine_states


def test_service_order_transitions_match_state_machine(contract: dict[str, Any]) -> None:
    contract_transitions = set(
        contract["components"]["schemas"]["ServiceOrderTransition"]["enum"]
    )
    machine_transitions = {t["name"] for t in _machine("service-order.json")["transitions"]}
    assert contract_transitions == machine_transitions


# ─────────────────────── Целостность самих автоматов ───────────────────────


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_transitions_reference_existing_states(name: str) -> None:
    machine = _machine(name)
    states = set(machine["states"])
    for transition in machine["transitions"]:
        unknown_from = set(transition["from"]) - states
        assert not unknown_from, f"{name}/{transition['name']}: неизвестные source {unknown_from}"
        assert transition["to"] in states, (
            f"{name}/{transition['name']}: неизвестный target {transition['to']}"
        )


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_initial_state_exists(name: str) -> None:
    machine = _machine(name)
    assert machine["initial"] in machine["states"]


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_every_guard_is_documented(name: str) -> None:
    """Guard без описания невозможно показать пользователю в списке невыполненных условий."""
    machine = _machine(name)
    documented = set(machine["guardDescriptions"])
    used = {guard for t in machine["transitions"] for guard in t["guards"]}
    assert used <= documented, f"{name}: не описаны guard-ы {used - documented}"


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_every_state_is_reachable(name: str) -> None:
    """Недостижимое состояние — ошибка проектирования, а не мёртвый код."""
    machine = _machine(name)
    reachable = {machine["initial"]}
    for transition in machine["transitions"]:
        reachable.add(transition["to"])
    unreachable = set(machine["states"]) - reachable
    assert not unreachable, f"{name}: недостижимые состояния {unreachable}"


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_every_state_has_bilingual_name(name: str) -> None:
    """ТЗ 4.5: полный ru/en, включая наименования статусов."""
    for code, state in _machine(name)["states"].items():
        assert state.get("nameRu"), f"{name}/{code}: нет русского наименования"
        assert state.get("nameEn"), f"{name}/{code}: нет английского наименования"


@pytest.mark.parametrize("name", ["flight.json", "service-order.json"])
def test_reason_requiring_transitions_declare_guard(name: str) -> None:
    """Переход, требующий причину, обязан её проверять, а не надеяться на интерфейс."""
    for transition in _machine(name)["transitions"]:
        if transition.get("requiresReason"):
            assert "reason_provided" in transition["guards"], (
                f"{name}/{transition['name']}: требует причину, но не проверяет её"
            )


# ─────────────────────── Правила контракта ───────────────────────


def test_contract_is_openapi_31(contract: dict[str, Any]) -> None:
    assert contract["openapi"].startswith("3.1")


def test_money_amount_is_string_not_number(contract: dict[str, Any]) -> None:
    """CLAUDE.md § 3 п. 1: float в деньгах запрещён, в том числе в JSON."""
    money = contract["components"]["schemas"]["Money"]
    amount = money["properties"]["amount"]
    assert amount["$ref"].endswith("DecimalString")
    decimal_string = contract["components"]["schemas"]["DecimalString"]
    assert decimal_string["type"] == "string"


def test_mutating_endpoints_declare_idempotency(contract: dict[str, Any]) -> None:
    """ADR-018: каждый POST явно объявляет, обязателен ли ключ идемпотентности."""
    missing: list[str] = []
    for path, operations in contract["paths"].items():
        post = operations.get("post")
        if post is None:
            continue
        if "x-idempotency" not in post:
            missing.append(path)
    assert not missing, f"POST без объявленной политики идемпотентности: {missing}"


def test_required_idempotency_endpoints_declare_header(contract: dict[str, Any]) -> None:
    """Обязательный ключ должен быть виден в контракте, иначе клиент его не отправит."""
    problems: list[str] = []
    for path, operations in contract["paths"].items():
        post = operations.get("post")
        if post is None or post.get("x-idempotency") != "required":
            continue
        declared = post.get("parameters", []) + operations.get("parameters", [])
        refs = [p.get("$ref", "") for p in declared if isinstance(p, dict)]
        if not any("IdempotencyKey" in ref for ref in refs):
            problems.append(path)
    assert not problems, (
        f"объявлен x-idempotency: required, но заголовок не описан в параметрах: {problems}"
    )
