"""Сериализаторы справочников. Форма ответа — по `openapi.yaml`."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from rest_framework import serializers

from catalog.models import AircraftType, Airport, Service, VatRate, VendorPrice
from catalog.services import SURCHARGE_CODES
from core.api.fields import LocalizedNameField, LocalizedTextField
from core.money import SUPPORTED_CURRENCIES
from counterparties.models import Vendor


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


class MoneyInputSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Денежная величина на входе: сумма строкой, валюта из перечня `[ТЗ 3.4.1]`."""

    amount = serializers.DecimalField(max_digits=18, decimal_places=4, min_value=Decimal(0))
    currency = serializers.CharField(max_length=3)

    def validate_currency(self, value: str) -> str:
        code = value.upper()
        if code not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError(
                f"Валюта {code} не поддерживается. "
                f"Допустимы: {', '.join(sorted(SUPPORTED_CURRENCIES))}"
            )
        return code


class SurchargeSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`Surcharge` из контракта (ADR-021)."""

    code = serializers.ChoiceField(choices=sorted(SURCHARGE_CODES))
    kind = serializers.ChoiceField(choices=["percent", "fixed"])
    value = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=True)
    appliesWhen = serializers.DictField(required=False)  # noqa: N815


class VendorPriceSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """`VendorPrice` из контракта."""

    vendorId = serializers.CharField(source="vendor_id")  # noqa: N815
    serviceId = serializers.CharField(source="service_id")  # noqa: N815
    airportIcao = serializers.CharField(source="airport_icao")  # noqa: N815
    price = serializers.SerializerMethodField()
    minCharge = serializers.SerializerMethodField()  # noqa: N815
    validFrom = serializers.DateTimeField(source="valid_from")  # noqa: N815
    validTo = serializers.DateTimeField(source="valid_to")  # noqa: N815
    # Наименования поставщика и услуги в строке прайса: без них таблица цен
    # читается только со словарём идентификаторов на соседнем экране.
    vendorName = serializers.CharField(source="vendor.name", read_only=True)  # noqa: N815
    serviceCode = serializers.CharField(source="service.code", read_only=True)  # noqa: N815

    class Meta:
        model = VendorPrice
        fields = (
            "id", "vendorId", "vendorName", "serviceId", "serviceCode", "airportIcao",
            "price", "minCharge", "validFrom", "validTo", "surcharges",
        )

    def get_price(self, obj: VendorPrice) -> dict[str, str]:
        return {"amount": str(obj.amount), "currency": obj.currency}

    def get_minCharge(self, obj: VendorPrice) -> dict[str, str] | None:  # noqa: N802
        if obj.min_charge_amount is None:
            return None
        return {"amount": str(obj.min_charge_amount), "currency": obj.currency}


class VendorPriceCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`VendorPriceCreate` из контракта."""

    vendorId = serializers.CharField()  # noqa: N815
    serviceId = serializers.CharField()  # noqa: N815
    airportIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    price = MoneyInputSerializer()
    minCharge = MoneyInputSerializer(required=False, allow_null=True)  # noqa: N815
    validFrom = serializers.DateTimeField()  # noqa: N815
    validTo = serializers.DateTimeField()  # noqa: N815
    surcharges = SurchargeSerializer(many=True, required=False, default=list)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["validTo"] <= attrs["validFrom"]:
            raise serializers.ValidationError(
                {"validTo": "Дата окончания действия цены обязана быть позже даты начала"}
            )
        if not Vendor.objects.filter(pk=attrs["vendorId"], is_active=True).exists():
            raise serializers.ValidationError({"vendorId": "Поставщик не найден"})
        if not Service.objects.filter(pk=attrs["serviceId"], is_active=True).exists():
            raise serializers.ValidationError({"serviceId": "Услуга не найдена в каталоге"})

        icao = attrs["airportIcao"].upper()
        if not Airport.objects.filter(icao=icao).exists():
            raise serializers.ValidationError(
                {"airportIcao": f"Аэропорта {icao} нет в справочнике"}
            )
        attrs["airportIcao"] = icao

        minimum = attrs.get("minCharge")
        if minimum and minimum["currency"] != attrs["price"]["currency"]:
            raise serializers.ValidationError(
                {"minCharge": "Минимальный чек обязан быть в валюте цены"}
            )
        return attrs


class AirportCreateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Добавление аэропорта в справочник.

    Справочник наполняется из открытых источников командой `seed_reference`
    (`CLAUDE.md § 4`), но диспетчеру бывает нужна площадка, которой в выгрузке
    нет: частный аэродром, временный пункт. Ручной ввод — штатный путь,
    а не обход. Запись помечается `data_source='user'` и отличима от выгрузки.
    """

    # Коды объявлены явно, без валидатора модели: тот требует верхнего
    # регистра, а проверка поля в DRF идёт до `validate_icao`, где регистр
    # приводится. Человек, набравший `uwkd`, получил бы отказ вместо записи.
    icao = serializers.RegexField(
        r"^[A-Za-z]{4}$",
        error_messages={"invalid": "Код ИКАО — четыре латинские буквы, например UWKD"},
    )
    iata = serializers.RegexField(
        r"^[A-Za-z]{3}$", required=False, allow_blank=True, default=""
    )
    country = serializers.RegexField(
        r"^[A-Za-z]{2}$",
        error_messages={
            "invalid": "Код страны — две латинские буквы по ISO 3166-1 alpha-2, например RU"
        },
    )
    name = LocalizedNameField()
    city = LocalizedNameField(prefix="city", required=False)
    elevationFt = serializers.IntegerField(source="elevation_ft", default=0)  # noqa: N815
    isCoordinated = serializers.BooleanField(source="is_coordinated", default=False)  # noqa: N815

    class Meta:
        model = Airport
        fields = (
            "icao", "iata", "name", "city", "country", "timezone",
            "lat", "lon", "elevationFt", "isCoordinated",
        )

    def validate_icao(self, value: str) -> str:
        code = value.upper()
        if Airport.objects.filter(icao=code).exists():
            raise serializers.ValidationError(f"Аэропорт {code} уже есть в справочнике")
        return code

    def validate_iata(self, value: str) -> str:
        return value.upper()

    def validate_country(self, value: str) -> str:
        return value.upper()

    def validate_timezone(self, value: str) -> str:
        """Зона обязана существовать: от неё считается местное время на экране.

        Ошибка в зоне не заметна сразу и всплывает на рейсе, у которого
        местное время вылета разъехалось с расписанием аэропорта.
        """
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise serializers.ValidationError(
                f"Неизвестная временная зона {value}. Ожидается зона IANA, "
                f"например Europe/Moscow"
            ) from exc
        return value
