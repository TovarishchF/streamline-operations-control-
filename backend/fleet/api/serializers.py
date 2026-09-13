"""Сериализаторы парка воздушных судов."""

from __future__ import annotations

from rest_framework import serializers

from catalog.api.serializers import AircraftTypeSerializer
from fleet.models import Aircraft, AircraftApproval


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
