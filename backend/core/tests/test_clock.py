"""Тесты единого источника времени и запрета прямого обращения к часам."""

from __future__ import annotations

import ast
from datetime import UTC, timedelta
from pathlib import Path

import pytest
from django.test import override_settings

from core import clock

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent

# Модули, которым обращение к системным часам разрешено: сам источник времени
# и его тесты. Всё остальное обязано ходить через core.clock.now().
CLOCK_EXEMPT = {"core/clock.py", "core/tests/test_clock.py"}


def test_now_is_timezone_aware_and_utc() -> None:
    """Наивных datetime в системе не существует (CLAUDE.md § 3 п. 2)."""
    value = clock.now()
    assert value.tzinfo is not None
    assert value.utcoffset() == timedelta(0)


def test_real_now_is_utc() -> None:
    assert clock.real_now().tzinfo == UTC


@override_settings(DEMO_DATA=False)
def test_no_shift_without_demo_mode() -> None:
    """Вне демонстрационного режима смещение недоступно и БД не опрашивается."""
    assert clock.is_shifted() is False
    delta = abs((clock.now() - clock.real_now()).total_seconds())
    assert delta < 1


@override_settings(DEMO_DATA=False)
def test_today_is_midnight_utc() -> None:
    value = clock.today()
    assert (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0)


# ────────────── Статическая проверка: запрет datetime.now() ──────────────


def _python_sources() -> list[Path]:
    files: list[Path] = []
    for path in BACKEND_ROOT.rglob("*.py"):
        relative = path.relative_to(BACKEND_ROOT).as_posix()
        if relative.startswith((".venv/", "config/")) or "/migrations/" in relative:
            continue
        if relative in CLOCK_EXEMPT:
            continue
        files.append(path)
    return files


def _calls_forbidden_clock(tree: ast.AST) -> list[str]:
    """Ищет datetime.now(), datetime.utcnow(), date.today() и time.time()."""
    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        attr = node.func.attr
        owner = node.func.value
        owner_name = owner.id if isinstance(owner, ast.Name) else getattr(owner, "attr", "")
        if attr in {"now", "utcnow"} and owner_name in {"datetime", "dt"}:
            found.append(f"{owner_name}.{attr}()")
        elif attr == "today" and owner_name in {"date", "datetime"}:
            found.append(f"{owner_name}.today()")
    return found


@pytest.mark.parametrize("source", _python_sources(), ids=lambda p: p.name)
def test_domain_code_does_not_call_system_clock(source: Path) -> None:
    """В доменном коде datetime.now() запрещён — только core.clock.now().

    Правило существует, чтобы демонстрационное смещение времени (ADR-014)
    и тесты применялись в одной точке, а не в сорока.
    """
    tree = ast.parse(source.read_text(encoding="utf-8"))
    violations = _calls_forbidden_clock(tree)
    assert not violations, (
        f"{source.relative_to(BACKEND_ROOT)}: обнаружено обращение к системным часам "
        f"{violations}. Используйте core.clock.now() (CLAUDE.md § 3 п. 2)."
    )
