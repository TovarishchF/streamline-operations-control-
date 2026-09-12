#!/usr/bin/env python
"""Сверка согласованного контракта со схемой, сгенерированной из кода.

`SPEC.md § 10.2`: `openapi.yaml` — контракт, согласованный до написания кода.
Расхождение между ним и схемой сервера — ошибка сборки, а не предмет обсуждения:
именно так сервер и клиенты расходятся молча (`TESTING.md § 3`).

Сверяются: перечень путей и методов, коды ответов и состав перечислений.
Порядок ключей и тексты описаний не сверяются — они не влияют на совместимость.

Два вида расхождений различаются намеренно:

* **Всегда ошибка** — сервер реализует то, чего нет в контракте, либо реализованный
  эндпоинт расходится с контрактом по кодам ответов или перечислениям. Это значит,
  что клиенты получат не то, на что рассчитывают.
* **Ошибка только в строгом режиме** — контракт объявляет эндпоинт, которого сервер
  ещё не реализует. По `TASKS.md` контракт согласуется на M0 целиком, а реализуется
  до M10, поэтому во время разработки это нормальное состояние. Строгий режим
  включается на M15, когда реализация обязана покрыть контракт полностью.

Использование:
    python scripts/check_schema_drift.py openapi.yaml artifacts/openapi.generated.yaml
    python scripts/check_schema_drift.py --strict openapi.yaml artifacts/...
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}

# Схема сервера содержит полный путь, контракт — путь относительно servers.url.
API_PREFIX = "/api/v1"


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        sys.stderr.write(f"файл не найден: {path}\n")
        raise SystemExit(2)
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def operations(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Плоский словарь «МЕТОД путь» → операция, с нормализованным префиксом."""
    result: dict[str, dict[str, Any]] = {}
    for raw_path, item in (spec.get("paths") or {}).items():
        path = raw_path[len(API_PREFIX) :] if raw_path.startswith(API_PREFIX) else raw_path
        path = path.rstrip("/") or "/"
        for method, operation in item.items():
            if method in HTTP_METHODS:
                result[f"{method.upper()} {path}"] = operation
    return result


def enums(spec: dict[str, Any]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for name, schema in (spec.get("components", {}).get("schemas") or {}).items():
        if isinstance(schema, dict) and "enum" in schema:
            result[name] = set(schema["enum"])
    return result


def compare(
    contract: dict[str, Any], generated: dict[str, Any]
) -> tuple[list[str], list[str]]:
    """Возвращает (ошибки, ещё-не-реализованное)."""
    problems: list[str] = []
    pending: list[str] = []

    contract_ops = operations(contract)
    generated_ops = operations(generated)

    pending.extend(sorted(set(contract_ops) - set(generated_ops)))

    for op in sorted(set(generated_ops) - set(contract_ops)):
        problems.append(f"реализовано сервером, но отсутствует в контракте: {op}")

    for op in sorted(set(contract_ops) & set(generated_ops)):
        expected = set((contract_ops[op].get("responses") or {}).keys())
        actual = set((generated_ops[op].get("responses") or {}).keys())
        missing = expected - actual
        if missing:
            problems.append(f"{op}: сервер не объявляет коды ответов {sorted(missing)}")

    contract_enums = enums(contract)
    generated_enums = enums(generated)
    for name in sorted(set(contract_enums) & set(generated_enums)):
        if contract_enums[name] != generated_enums[name]:
            problems.append(
                f"перечисление {name}: только в контракте "
                f"{sorted(contract_enums[name] - generated_enums[name])}, "
                f"только у сервера {sorted(generated_enums[name] - contract_enums[name])}"
            )

    contract_version = str(contract.get("openapi", ""))
    if not contract_version.startswith("3.1"):
        problems.append(f"контракт обязан быть OpenAPI 3.1, а не {contract_version} (G-52)")

    generated_version = str(generated.get("openapi", ""))
    if not generated_version.startswith("3.1"):
        problems.append(
            f"схема сервера обязана быть OpenAPI 3.1, а не {generated_version}: "
            f"задайте SPECTACULAR_SETTINGS['OAS_VERSION'] = '3.1.0'"
        )

    return problems, pending


def main() -> int:
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    strict = "--strict" in sys.argv

    if len(args) != 2:
        sys.stderr.write(
            f"использование: {sys.argv[0]} [--strict] <контракт> <сгенерированная схема>\n"
        )
        return 2

    problems, pending = compare(load(Path(args[0])), load(Path(args[1])))

    if strict:
        problems.extend(
            f"объявлено в контракте, но не реализовано сервером: {op}" for op in pending
        )

    if problems:
        sys.stderr.write("Схема сервера разошлась с контрактом:\n\n")
        for problem in problems:
            sys.stderr.write(f"  • {problem}\n")
        sys.stderr.write(
            "\nКонтракт согласуется до кода (SPEC.md § 10.2). Приведите сервер "
            "в соответствие либо измените контракт отдельным коммитом с указанием, "
            "кто из клиентов затронут (CLAUDE.md § 8 п. 5).\n"
        )
        return 1

    implemented = len(operations(load(Path(args[1]))))
    declared = implemented + len(pending)
    sys.stdout.write(
        f"Схема сервера не противоречит контракту. "
        f"Реализовано {implemented} из {declared} операций.\n"
    )
    if pending:
        sys.stdout.write(
            f"Ещё не реализовано: {len(pending)}. Это нормально до M15, "
            f"когда проверка переводится в строгий режим (--strict).\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
