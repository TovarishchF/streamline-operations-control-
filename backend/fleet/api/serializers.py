"""Сериализаторы парка воздушных судов."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from catalog.api.serializers import AircraftTypeSerializer
from catalog.models import AircraftType, Airport
from counterparties.models import Client
from fleet.models import Aircraft, AircraftApproval, AircraftStatus


class AircraftApprovalSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    validFrom = serializers.DateTimeField(source="valid_from")  # noqa: N815
    validTo = serializers.DateTimeField(source="valid_to")  # noqa: N815

    class Meta:
        model = AircraftApproval
        fields = ("kind", "number", "validFrom", "validTo")


class AircraftSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    typeId = serializers.CharField(source="type_id", read_only=True)  # noqa: N815
    type = AircraftTypeSerializer(read_only=True)
    operatorId = serializers.CharField(source="operator_id", read_only=True)  # noqa: N815
    homeBaseIcao = serializers.CharField(source="home_base_icao")  # noqa: N815
    approvals = AircraftApprovalSerializer(many=True, read_only=True)

    class Meta:
        model = Aircraft
        fields = (
            "id", "registration", "typeId", "type", "operatorId",
            "status", "homeBaseIcao", "approvals", "notes",
        )


class AircraftUpdateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Изменение состояния борта `[ТЗ 3.1.3]`.

    Меняются только состояние и примечание: бортовой номер и тип — это
    другая машина, а не изменение этой.
    """

    class Meta:
        model = Aircraft
        fields = ("status", "notes")


class AircraftCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Постановка борта в парк `[ТЗ 3.1.3]`.

    Бортовой номер уникален и приводится к верхнему регистру: `ra-73000`
    и `RA-73000` — один и тот же борт, и допустить их обоих в парк значит
    получить два расписания на одну машину.
    """

    registration = serializers.CharField(max_length=16)
    typeId = serializers.CharField()  # noqa: N815
    operatorId = serializers.CharField(required=False, allow_null=True, allow_blank=True)  # noqa: N815
    homeBaseIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    status = serializers.ChoiceField(
        choices=AircraftStatus.choices, default=AircraftStatus.SERVICEABLE
    )
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    approvals = AircraftApprovalSerializer(many=True, required=False, default=list)

    def validate_registration(self, value: str) -> str:
        registration = value.strip().upper()
        if Aircraft.objects.filter(registration=registration).exists():
            raise serializers.ValidationError(f"Борт {registration} уже есть в парке")
        return registration

    def validate_typeId(self, value: str) -> str:  # noqa: N802
        if not AircraftType.objects.filter(pk=value).exists():
            raise serializers.ValidationError("Тип воздушного судна не найден в справочнике")
        return value

    def validate_homeBaseIcao(self, value: str) -> str:  # noqa: N802
        icao = value.upper()
        if not Airport.objects.filter(icao=icao).exists():
            raise serializers.ValidationError(f"Аэропорта {icao} нет в справочнике")
        return icao

    def validate_operatorId(self, value: str | None) -> str | None:  # noqa: N802
        if not value:
            return None
        if not Client.objects.filter(pk=value, is_active=True).exists():
            raise serializers.ValidationError("Эксплуатант не найден среди клиентов")
        return value

    def validate_approvals(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for approval in value:
            if approval["valid_to"] <= approval["valid_from"]:
                raise serializers.ValidationError(
                    f"У допуска {approval['kind']} дата окончания раньше даты начала"
                )
        return value
