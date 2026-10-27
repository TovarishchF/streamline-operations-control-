#!/bin/sh
# Установка SOC с данными генератора на сервер с Docker.
#
#   sh deploy/sample/install.sh [адрес сервера] [порт]
#
# Адрес — тот, по которому систему будут открывать в браузере (IP или имя).
# Без него берётся первый адрес сервера. Порт по умолчанию — 80.
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.sample.yml"

if ! command -v docker >/dev/null 2>&1; then
    echo "Не найден Docker. Установка: https://docs.docker.com/engine/install/"
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "Не найден Docker Compose v2 (команда «docker compose»)."
    exit 1
fi

HOST="${1:-}"
PORT="${2:-80}"
if [ -z "$HOST" ]; then
    HOST=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    [ -n "$HOST" ] || HOST=localhost
fi
if [ "$PORT" = "80" ]; then
    PUBLIC_URL="http://$HOST"
else
    PUBLIC_URL="http://$HOST:$PORT"
fi

if [ -f .env ]; then
    echo "Файл .env уже есть — используются его значения."
else
    random() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
    sed -e "s|{{SECRET_KEY}}|$(random)|" \
        -e "s|{{DB_PASSWORD}}|$(random)|g" \
        -e "s|{{S3_SECRET}}|$(random)|" \
        -e "s|{{HOST}}|$HOST|" \
        -e "s|{{PORT}}|$PORT|" \
        -e "s|{{PUBLIC_URL}}|$PUBLIC_URL|" \
        -e "s|{{VERSION}}|$(cat VERSION 2>/dev/null || echo unknown)|" \
        deploy/sample/env.template > .env
    chmod 600 .env
    echo "Создан .env для адреса $PUBLIC_URL"
fi

echo "Сборка и запуск. Первый раз — 10–20 минут: сборка образов, база, справочники, набор данных."
$COMPOSE up -d --build

echo
echo "Готово: $PUBLIC_URL"
echo "Пароль всех пользователей: soc-vhod-2026-parol"
echo "  volkova   — администратор"
echo "  karpov    — диспетчер"
echo "  gordeeva  — финансист"
echo "  sokolov   — руководитель"
echo "  lebedeva  — портал клиента"
echo "  zaharov   — портал поставщика"
