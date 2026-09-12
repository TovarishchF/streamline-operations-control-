# SOC — единая точка входа для всех команд (CLAUDE.md § 7).
# Цели, работающие без Docker, вызывают локальное окружение backend/.venv.

.DEFAULT_GOAL := help
.PHONY: help up down logs migrate makemigrations shell superuser \
        seed-reference seed-demo demo-reset \
        api-schema api-types lint types test test-e2e test-load test-restore check \
        venv install format

COMPOSE       := docker compose
PROFILE       ?= dev
PY            := backend/.venv/Scripts/python.exe
PY_UNIX       := backend/.venv/bin/python
PYTHON        := $(shell test -f $(PY) && echo $(PY) || echo $(PY_UNIX))
MANAGE        := cd backend && ../$(PYTHON) manage.py

help:  ## Список команд
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ─────────────────────────── Окружение ───────────────────────────

up:  ## Поднять окружение (PROFILE=dev|demo|prod)
	$(COMPOSE) --profile $(PROFILE) up -d
	@echo "API: http://localhost:8000/api/v1/health   Веб: http://localhost:5173"
	@echo "Почта (dev): http://localhost:8025"

down:  ## Остановить окружение
	$(COMPOSE) --profile $(PROFILE) down

logs:  ## Журналы сервисов
	$(COMPOSE) --profile $(PROFILE) logs -f --tail=100

venv:  ## Создать локальное окружение backend/.venv (Python 3.12)
	cd backend && uv venv --python 3.12 .venv

install: venv  ## Установить зависимости сервера
	cd backend && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"

# ─────────────────────────── База данных ───────────────────────────

migrate:  ## Применить миграции
	$(MANAGE) migrate

makemigrations:  ## Создать миграции (проверить глазами перед коммитом — CLAUDE.md § 3 п. 12)
	$(MANAGE) makemigrations

shell:  ## Django shell
	$(MANAGE) shell

superuser:  ## Создать администратора
	$(MANAGE) createsuperuser

seed-reference:  ## Справочники: аэропорты, типы ВС, ставки НДС
	$(MANAGE) seed_reference

seed-demo:  ## Демонстрационный набор (только при DEMO_DATA=true)
	$(MANAGE) seed_demo --seed 20260912

demo-reset:  ## Сброс и перегенерация демо-данных
	$(MANAGE) seed_demo --purge
	$(MANAGE) seed_demo --seed 20260912

# ─────────────────────────── Контракт API ───────────────────────────

api-schema:  ## Сгенерировать схему из кода и сверить с openapi.yaml
	$(MANAGE) spectacular --file ../artifacts/openapi.generated.yaml --validate
	$(PYTHON) scripts/check_schema_drift.py openapi.yaml artifacts/openapi.generated.yaml

api-types:  ## Сгенерировать shared/api-types.ts из контракта
	npx --yes openapi-typescript openapi.yaml -o shared/api-types.ts
	@echo "Типы клиентов сгенерированы. Руками их писать нельзя — CLAUDE.md § 3 п. 6."

# ─────────────────────────── Качество ───────────────────────────

lint:  ## ruff + eslint
	cd backend && ../$(PYTHON) -m ruff check .
	cd web && npm run lint

format:  ## Автоформатирование
	cd backend && ../$(PYTHON) -m ruff check . --fix && ../$(PYTHON) -m ruff format .
	cd web && npm run format

types:  ## mypy --strict + tsc --noEmit
	cd backend && ../$(PYTHON) -m mypy .
	cd web && npm run typecheck

test:  ## pytest + vitest
	cd backend && ../$(PYTHON) -m pytest -q
	cd web && npm run test -- --run

test-e2e:  ## Playwright
	cd e2e && npx playwright test

test-load:  ## k6, отчёт в artifacts/
	cd load && k6 run --out json=../artifacts/k6-$(shell date +%Y%m%d-%H%M%S).json main.js

test-restore:  ## Испытание восстановления из копии, журнал в artifacts/
	./deploy/restore-drill.sh

check: lint types test  ## Обязательно перед коммитом (CLAUDE.md § 8 п. 7)
	@echo "Проверки пройдены."
