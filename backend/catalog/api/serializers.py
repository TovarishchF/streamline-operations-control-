"""Сериализаторы справочников. Форма ответа — по `openapi.yaml`."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from catalog.models import AircraftType, Airport, Service, VatRate
from core.api.fields import LocalizedNameField, LocalizedTextField


class AirportSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    name = LocalizedNameField()
    city = LocalizedTextField(prefix="city")
    elevationFt = serializers.IntegerField(source="elevation_ft", read_only=True)  # noqa: N815
    isCoordinated = serializers.BooleanField(source="is_coordinated")  # noqa: N815

    class Meta:
        model = Airport
        fields = (
            "id", "icao", "iata", "name", "city", "country", "timezone",
            "lat", "lon", "elevationFt", "isCoordinated",
        )


class AircraftTypeSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    icaoType = serializers.CharField(source="icao_type")  # noqa: N815
    name = LocalizedNameField()
    cruiseSpeedKts = serializers.IntegerField(source="cruise_speed_kts")  # noqa: N815
    fuelBurnKgPerHour = serializers.IntegerField(source="fuel_burn_kg_per_hour")  # noqa: N815
    turnaroundMin = serializers.IntegerField(source="turnaround_min")  # noqa: N815

    class Meta:
        model = AircraftType
        fields = (
            "id", "icaoType", "name", "category", "seats",
            "cruiseSpeedKts", "fuelBurnKgPerHour", "turnaroundMin",
        )


class VatRateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    name = LocalizedNameField()
    # Процент строкой: число с плавающей точкой в JSON запрещено
    # (`CLAUDE.md § 3` п. 1). COERCE_DECIMAL_TO_STRING делает это по умолчанию,
    # объявление здесь — чтобы это было видно в коде, а не только в настройках.
    percent = serializers.DecimalField(max_digits=6, decimal_places=4, coerce_to_string=True)

    class Meta:
        model = VatRate
        fields = ("id", "code", "name", "percent", "applicability")


class ServiceSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    name = LocalizedNameField()
    requiresWeather = serializers.BooleanField(source="requires_weather", required=False)  # noqa: N815
    leadTimeH = serializers.IntegerField(source="lead_time_h", required=False)  # noqa: N815
    requiresActToComplete = serializers.BooleanField(  # noqa: N815
        source="requires_act_to_complete", required=False
    )
    requiredAttributes = serializers.JSONField(  # noqa: N815
        source="required_attributes", required=False
    )

    class Meta:
        model = Service
        fields = (
            "id", "code", "category", "name", "unit",
            "requiresWeather", "leadTimeH", "requiredAttributes", "requiresActToComplete",
        )

    def validate_requiredAttributes(self, value: Any) -> Any:  # noqa: N802
        """Схема атрибутов — список описаний, а не произвольный JSON.

        Проверка здесь, а не в модели: это форма входных данных, и ошибка
        должна вернуться пользователю как 400, а не упасть при сохранении.
        """
        if not isinstance(value, list):
            raise serializers.ValidationError("Ожидается список описаний атрибутов")
        allowed_types = {"number", "string", "enum", "boolean"}
        for item in value:
            if not isinstance(item, dict):
                raise serializers.ValidationError("Описание атрибута должно быть объектом")
            missing = {"key", "type", "required"} - set(item)
            if missing:
                raise serializers.ValidationError(
                    f"В описании атрибута нет полей: {', '.join(sorted(missing))}"
                )
            if item["type"] not in allowed_types:
                raise serializers.ValidationError(
                    f"Недопустимый тип атрибута: {item['type']}"
                )
        return value
