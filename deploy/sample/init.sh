#!/bin/sh
# Первый запуск установки для показа (docker-compose.sample.yml, служба init).
#
# Каждый шаг можно повторять: перезапуск ничего не дублирует. Набор
# генератора строится относительно сегодняшней даты (CLAUDE.md § 4),
# поэтому собирается здесь, на сервере, а не привозится готовой базой.
set -eu

python manage.py migrate --noinput
python manage.py seed_reference
python manage.py setup_periodic_tasks

# Курсы валют — только ЦБ РФ (ADR-039). К поставке приложен снимок
# настоящих курсов ЦБ на случай, если сервер не видит www.cbr.ru; записи
# снимка помечены data_source=imported. Затем — свежие курсы от ЦБ.
if python manage.py shell -c "from billing.models import FxRate; raise SystemExit(0 if FxRate.objects.exists() else 1)"; then
    echo "курсы валют уже загружены"
else
    python manage.py loaddata /deploy/fx-rates-cbr.json
fi
python manage.py sync_fx --days 45 || echo "ЦБ РФ недоступен: документы считаются по курсам из поставки"

if python manage.py shell -c "from flights.models import Flight; raise SystemExit(0 if Flight.objects.filter(is_generated=True).exists() else 1)"; then
    echo "набор генератора уже создан"
else
    echo "набор генератора: несколько минут"
    python manage.py seed_sample --seed 20260912
fi
