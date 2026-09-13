"""Загрузка справочников из `shared/reference/` `[ТЗ этап 3]`.

`make seed-reference`. Команда идемпотентна: повторный запуск обновляет
записи по естественному ключу (код ИКАО, обозначение типа, код услуги
или ставки), а не плодит дубли. Это нужно и при обновлении справочника
из открытых источников, и при развёртывании.

Происхождение записей — `imported`, а не `synthetic`: это настоящие
общедоступные справочные данные (`CLAUDE.md § 4`), в отличие от наименований
клиентов и поставщиков, которые генератор придумывает.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from catalog.models import AircraftType, Airport, Service, VatRate
from core.models import BaseModel, DataSource

if TYPE_CHECKING:
    from argparse import ArgumentParser

DATASETS = ("airports", "aircraft-types", "vat-rates", "services")


class Command(BaseCommand):
    help = "Загружает справочники из shared/reference/"

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument(
            "--only",
            default=",".join(DATASETS),
            help=f"Наборы через запятую: {', '.join(DATASETS)}",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        directory = Path(settings.SHARED_DIR) / "reference"
        if not directory.is_dir():
            raise CommandError(f"каталог справочников не найден: {directory}")

        requested = [name.strip() for name in str(options["only"]).split(",") if name.strip()]
        unknown = sorted(set(requested) - set(DATASETS))
        if unknown:
            raise CommandError(f"неизвестный набор: {', '.join(unknown)}")

        loaders = {
            "airports": self._load_airports,
            "aircraft-types": self._load_aircraft_types,
            "vat-rates": self._load_vat_rates,
            "services": self._load_services,
        }
        for name in requested:
            created, updated = loaders[name](directory)
            self.stdout.write(f"{name}: добавлено {created}, обновлено {updated}")

    # ─────────────────────────── наборы ───────────────────────────

    def _load_airports(self, directory: Path) -> tuple[int, int]:
        path = directory / "airports.csv"
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        return self._upsert(
            Airport,
            "icao",
            [
                {
                    "icao": row["icao"],
                    "iata": row["iata"],
                    "name_ru": row["name_ru"],
                    "name_en": row["name_en"],
                    "city_ru": row["city_ru"],
                    "city_en": row["city_en"],
                    "country": row["country"],
                    "timezone": row["timezone"],
                    "lat": float(row["lat"]),
                    "lon": float(row["lon"]),
                    "elevation_ft": int(row["elevation_ft"] or 0),
                    "is_coordinated": row["is_coordinated"] == "true",
                }
                for row in rows
            ],
        )

    def _load_aircraft_types(self, directory: Path) -> tuple[int, int]:
        payload = _read_json(directory / "aircraft-types.json")
        return self._upsert(
            AircraftType,
            "icao_type",
            [
                {
                    "icao_type": item["icaoType"],
                    "name_ru": item["nameRu"],
                    "name_en": item["nameEn"],
                    "category": item["category"],
                    "seats": item["seats"],
                    "cruise_speed_kts": item["cruiseSpeedKts"],
                    "fuel_burn_kg_per_hour": item["fuelBurnKgPerHour"],
                    "turnaround_min": item["turnaroundMin"],
                }
                for item in payload["aircraftTypes"]
            ],
        )

    def _load_vat_rates(self, directory: Path) -> tuple[int, int]:
        payload = _read_json(directory / "vat-rates.json")
        return self._upsert(
            VatRate,
            "code",
            [
                {
                    "code": item["code"],
                    "name_ru": item["nameRu"],
                    "name_en": item["nameEn"],
                    # Строкой, а не float: Decimal разбирает строку точно
                    # (CLAUDE.md § 3 п. 1).
                    "percent": item["percent"],
                    "applicability": item["applicability"],
                    "legal_basis": item.get("legalBasis", ""),
                    "note": item.get("note", ""),
                }
                for item in payload["vatRates"]
            ],
        )

    def _load_services(self, directory: Path) -> tuple[int, int]:
        payload = _read_json(directory / "services.json")
        return self._upsert(
            Service,
            "code",
            [
                {
                    "code": item["code"],
                    "category": item["category"],
                    "name_ru": item["nameRu"],
                    "name_en": item["nameEn"],
                    "unit": item["unit"],
                    "requires_weather": item.get("requiresWeather", False),
                    "lead_time_h": item.get("leadTimeH", 0),
                    "requires_act_to_complete": item.get("requiresActToComplete", False),
                    "required_attributes": item.get("requiredAttributes", []),
                }
                for item in payload["services"]
            ],
        )

    # ─────────────────────────── запись ───────────────────────────

    @transaction.atomic
    def _upsert(
        self, model: type[BaseModel], key: str, rows: list[dict[str, Any]]
    ) -> tuple[int, int]:
        """Обновляет по естественному ключу, считает добавленные и изменённые.

        Обновлением считается настоящее изменение значений: иначе повторный
        запуск на неизменившемся справочнике отчитывался бы о работе,
        которой не было, и поднимал бы `version` у каждой записи.

        Значения из файла приводятся типом поля модели. Без этого процент
        ставки НДС сравнивался бы как строка с `Decimal` и расходился всегда.
        """
        fields = {field.name: field for field in model._meta.get_fields()}
        existing = {
            getattr(obj, key): obj
            for obj in model._default_manager.filter(
                **{f"{key}__in": [row[key] for row in rows]}
            )
        }
        created = updated = 0
        for row in rows:
            obj = existing.get(row[key])
            if obj is None:
                model._default_manager.create(
                    **row, data_source=DataSource.IMPORTED, is_demo=False
                )
                created += 1
                continue
            changed = [
                field
                for field, value in row.items()
                if getattr(obj, field) != fields[field].to_python(value)  # type: ignore[union-attr]
            ]
            if not changed:
                continue
            for field in changed:
                setattr(obj, field, row[field])
            obj.data_source = DataSource.IMPORTED
            obj.save()
            updated += 1
        return created, updated


def _read_json(path: Path) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return payload
