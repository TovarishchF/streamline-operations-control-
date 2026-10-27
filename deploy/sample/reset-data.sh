#!/bin/sh
# Пересоздание набора генератора относительно сегодняшней даты.
# Удаляет только записи генератора; введённое людьми остаётся (ADR-016).
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.sample.yml"
$COMPOSE exec -T api python manage.py seed_sample --purge
$COMPOSE exec -T api python manage.py seed_sample --seed 20260912
