"""Сериализаторы рейсов. Форма ответа — по `openapi.yaml`."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from flights.models import (
    CrewMember,
    Flight,
    FlightRequest,
    FlightTemplate,
    FlightType,
    Slot,
)
from flights.services import conflicts as conflict_detector
from flights.services import transitions
from orders.models import ServiceOrderStatus

# Заявки, которые ещё требуют внимания диспетчера.
UNSETTLED_ORDER_STATUSES = (
    ServiceOrderStatus.DRAFT,
    ServiceOrderStatus.ORDERED,
    ServiceOrderStatus.REJECTED,
)


class CrewMemberSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    licenseNo = serializers.CharField(source="license_no", required=False)  # noqa: N815

    class Meta:
        model = CrewMember
        fields = ("name", "role", "licenseNo")


class FlightSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Рейс в форме контракта.

    Доступные и заблокированные переходы считаются на сервере и приходят
    готовыми: клиент не должен повторять логику автомата, иначе кнопка
    окажется активной там, где сервер ответит отказом (`SPEC § 4.4`).
    """

    clientId = serializers.CharField(source="client_id")  # noqa: N815
    aircraftId = serializers.CharField(source="aircraft_id", allow_null=True)  # noqa: N815
    depIcao = serializers.CharField(source="dep_icao")  # noqa: N815
    arrIcao = serializers.CharField(source="arr_icao")  # noqa: N815
    stdUtc = serializers.DateTimeField(source="std_utc")  # noqa: N815
    staUtc = serializers.DateTimeField(source="sta_utc")  # noqa: N815
    atdUtc = serializers.DateTimeField(source="atd_utc", allow_null=True)  # noqa: N815
    ataUtc = serializers.DateTimeField(source="ata_utc", allow_null=True)  # noqa: N815
    paxCount = serializers.IntegerField(source="pax_count")  # noqa: N815
    distanceNm = serializers.IntegerField(source="distance_nm")  # noqa: N815
    blockTimeMin = serializers.IntegerField(source="block_time_min")  # noqa: N815
    fuelPlanKg = serializers.IntegerField(source="fuel_plan_kg")  # noqa: N815
    billingCurrency = serializers.CharField(source="billing_currency")  # noqa: N815
    fxSnapshot = serializers.JSONField(source="fx_snapshot")  # noqa: N815
    templateId = serializers.CharField(source="template_id", allow_null=True)  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo")  # noqa: N815
    createdAt = serializers.DateTimeField(source="created_at")  # noqa: N815
    updatedAt = serializers.DateTimeField(source="updated_at")  # noqa: N815

    crew = CrewMemberSerializer(many=True, read_only=True)
    isInternational = serializers.SerializerMethodField()  # noqa: N815
    statusReason = serializers.SerializerMethodField()  # noqa: N815
    availableTransitions = serializers.SerializerMethodField()  # noqa: N815
    blockedTransitions = serializers.SerializerMethodField()  # noqa: N815

    class Meta:
        model = Flight
        fields: tuple[str, ...] = (
            "id", "number", "clientId", "aircraftId", "type", "depIcao", "arrIcao",
            "stdUtc", "staUtc", "atdUtc", "ataUtc", "status",
            "availableTransitions", "blockedTransitions", "statusReason",
            "isInternational", "paxCount", "crew", "distanceNm", "blockTimeMin",
            "fuelPlanKg", "billingCurrency", "fxSnapshot", "templateId", "remarks",
            "isDemo", "createdAt", "updatedAt",
        )

    def get_fields(self) -> dict[str, serializers.Field]:  # type: ignore[type-arg]
        fields = super().get_fields()
        # `source` — занятое имя у базового класса поля, а контракт его требует.
        fields["dataSource"] = serializers.CharField(source="data_source", read_only=True)
        return fields

    def get_isInternational(self, obj: Flight) -> bool:  # noqa: N802
        return obj.is_international

    def get_statusReason(self, obj: Flight) -> dict[str, str] | None:  # noqa: N802
        if not obj.status_reason_code:
            return None
        return {"code": obj.status_reason_code, "comment": obj.status_reason_comment}

    def get_availableTransitions(self, obj: Flight) -> list[str]:  # noqa: N802
        return [
            name
            for name in transitions.available_transitions(obj)
            if not transitions.check_guards(obj, name)
        ]

    def get_blockedTransitions(self, obj: Flight) -> list[dict[str, Any]]:  # noqa: N802
        """Недоступный переход показывается с причиной, а не прячется.

        Скрывать его — значит прятать причину: диспетчер должен видеть,
        чего не хватает, а не гадать, почему кнопки нет (`SPEC § 4.4`).
        """
        blocked = []
        for name in transitions.available_transitions(obj):
            problems = transitions.check_guards(obj, name)
            if problems:
                blocked.append({"transition": name, "unmetConditions": problems})
        return blocked


class FlightListSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Строка суточного плана (`FlightListItem` в контракте).

    Отдельный, более узкий набор полей: список листается постранично,
    а проверка условий переходов — это запросы к заявкам и слотам на каждую
    строку. На странице из пятидесяти рейсов их набирается несколько сотен.
    """

    clientId = serializers.CharField(source="client_id")  # noqa: N815
    clientName = serializers.CharField(source="client.name")  # noqa: N815
    aircraftId = serializers.CharField(source="aircraft_id", allow_null=True)  # noqa: N815
    aircraftRegistration = serializers.SerializerMethodField()  # noqa: N815
    depIcao = serializers.CharField(source="dep_icao")  # noqa: N815
    arrIcao = serializers.CharField(source="arr_icao")  # noqa: N815
    stdUtc = serializers.DateTimeField(source="std_utc")  # noqa: N815
    staUtc = serializers.DateTimeField(source="sta_utc")  # noqa: N815
    unconfirmedServicesCount = serializers.SerializerMethodField()  # noqa: N815
    marginPercent = serializers.SerializerMethodField()  # noqa: N815
    hasConflicts = serializers.SerializerMethodField()  # noqa: N815
    isDemo = serializers.BooleanField(source="is_demo")  # noqa: N815

    class Meta:
        model = Flight
        fields = (
            "id", "number", "clientId", "clientName", "aircraftId",
            "aircraftRegistration", "type", "depIcao", "arrIcao", "stdUtc", "staUtc",
            "status", "unconfirmedServicesCount", "marginPercent", "hasConflicts",
            "isDemo",
        )

    def get_aircraftRegistration(self, obj: Flight) -> str | None:  # noqa: N802
        return obj.aircraft.registration if obj.aircraft else None

    def get_unconfirmedServicesCount(self, obj: Flight) -> int:  # noqa: N802
        """Сколько заявок ещё не улажено.

        Счётчик считается по предзагруженным заявкам, если они есть:
        иначе на каждую строку списка уходит отдельный запрос.
        """
        orders = getattr(obj, "_prefetched_objects_cache", {}).get("service_orders")
        if orders is not None:
            return sum(1 for order in orders if order.status in UNSETTLED_ORDER_STATUSES)
        return obj.service_orders.filter(status__in=UNSETTLED_ORDER_STATUSES).count()

    def get_marginPercent(self, obj: Flight) -> str | None:  # noqa: N802
        """Маржа появится вместе с биллингом (M7).

        Поле отдаётся пустым, а не выдуманным: подставить сюда число
        значило бы показать диспетчеру расчёт, которого не было.
        """
        return None

    def get_hasConflicts(self, obj: Flight) -> bool:  # noqa: N802
        return bool(conflict_detector.detect(obj))


class FlightCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    clientId = serializers.CharField()  # noqa: N815
    aircraftId = serializers.CharField(required=False, allow_null=True)  # noqa: N815
    type = serializers.ChoiceField(choices=FlightType.choices, default=FlightType.CHARTER)
    depIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    arrIcao = serializers.CharField(min_length=4, max_length=4)  # noqa: N815
    stdUtc = serializers.DateTimeField()  # noqa: N815
    paxCount = serializers.IntegerField(required=False, default=0)  # noqa: N815
    remarks = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["depIcao"] == attrs["arrIcao"]:
            raise serializers.ValidationError(
                {"arrIcao": "Аэропорт вылета и прилёта совпадают"}
            )
        return attrs


class FlightUpdateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    aircraftId = serializers.CharField(required=False, allow_null=True)  # noqa: N815
    depIcao = serializers.CharField(required=False, min_length=4, max_length=4)  # noqa: N815
    arrIcao = serializers.CharField(required=False, min_length=4, max_length=4)  # noqa: N815
    stdUtc = serializers.DateTimeField(required=False)  # noqa: N815
    paxCount = serializers.IntegerField(required=False)  # noqa: N815
    remarks = serializers.CharField(required=False, allow_blank=True)


class FlightTransitionSerializer(serializers.Serializer):  # type: ignore[type-arg]
    transition = serializers.CharField()
    reasonCode = serializers.CharField(required=False, allow_blank=True, default="")  # noqa: N815
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class ConflictSerializer(serializers.Serializer):  # type: ignore[type-arg]
    kind = serializers.CharField()
    flightId = serializers.CharField()  # noqa: N815
    relatedFlightId = serializers.CharField(allow_null=True)  # noqa: N815
    message = serializers.CharField()
    severity = serializers.CharField()


class TemplateServiceSerializer(serializers.Serializer):  # type: ignore[type-arg]
    serviceId = serializers.CharField(source="service_id")  # noqa: N815
    leg = serializers.CharField()
    attributes = serializers.JSONField()


class FlightTemplateSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    clientId = serializers.CharField(source="client_id")  # noqa: N815
    aircraftTypeId = serializers.CharField(source="aircraft_type_id")  # noqa: N815
    depIcao = serializers.CharField(source="dep_icao")  # noqa: N815
    arrIcao = serializers.CharField(source="arr_icao")  # noqa: N815
    depTimeLocal = serializers.TimeField(source="dep_time_local", format="%H:%M")  # noqa: N815
    defaultServices = TemplateServiceSerializer(  # noqa: N815
        source="default_services", many=True, read_only=True
    )

    class Meta:
        model = FlightTemplate
        fields = (
            "id", "name", "clientId", "aircraftTypeId", "depIcao", "arrIcao",
            "depTimeLocal", "weekdays", "defaultServices",
        )


class FlightTemplateCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Заведение шаблона `[ТЗ 3.1.1]`.

    Отдельно от формы ответа: организация берётся из учётной записи,
    а не приходит от клиента, и услуги по умолчанию заводятся вместе
    с шаблоном — отдельного эндпоинта на них в контракте нет.
    """

    name = serializers.CharField(max_length=255)
    clientId = serializers.CharField()  # noqa: N815
    aircraftTypeId = serializers.CharField()  # noqa: N815
    depIcao = serializers.RegexField(r"^[A-Za-z]{4}$")  # noqa: N815
    arrIcao = serializers.RegexField(r"^[A-Za-z]{4}$")  # noqa: N815
    depTimeLocal = serializers.TimeField()  # noqa: N815
    weekdays = serializers.ListField(
        child=serializers.IntegerField(min_value=1, max_value=7), min_length=1
    )
    defaultServices = TemplateServiceSerializer(many=True, required=False, default=list)  # noqa: N815

    def validate_weekdays(self, value: list[int]) -> list[int]:
        """Дни недели без повторов и по порядку.

        Повтор дал бы два рейса в один день при генерации серии, а порядок
        нужен, чтобы шаблон читался одинаково при каждом показе.
        """
        return sorted(set(value))


class GenerateSeriesSerializer(serializers.Serializer):  # type: ignore[type-arg]
    fromDate = serializers.DateField()  # noqa: N815
    toDate = serializers.DateField()  # noqa: N815


class FlightRequestSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    clientId = serializers.CharField(source="client_id")  # noqa: N815
    depIcao = serializers.CharField(source="dep_icao")  # noqa: N815
    arrIcao = serializers.CharField(source="arr_icao")  # noqa: N815
    requestedStdUtc = serializers.DateTimeField(source="requested_std_utc")  # noqa: N815
    paxCount = serializers.IntegerField(source="pax_count")  # noqa: N815
    createdFlightId = serializers.CharField(source="flight_id", allow_null=True)  # noqa: N815
    rejectionReason = serializers.CharField(source="rejection_reason")  # noqa: N815
    createdAt = serializers.DateTimeField(source="created_at")  # noqa: N815

    class Meta:
        model = FlightRequest
        fields = (
            "id", "clientId", "depIcao", "arrIcao", "requestedStdUtc", "paxCount",
            "comment", "status", "createdFlightId", "rejectionReason", "createdAt",
        )


class ExportTicketSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`ExportTicket` из контракта. Форма та же, что у выгрузки отчётов."""

    taskId = serializers.CharField()  # noqa: N815
    status = serializers.ChoiceField(choices=["queued", "running", "ready", "failed"])
    downloadUrl = serializers.CharField(allow_null=True)  # noqa: N815
    expiresAt = serializers.DateTimeField(allow_null=True)  # noqa: N815


class SlotSerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    airportIcao = serializers.CharField(source="airport_icao")  # noqa: N815
    flightId = serializers.CharField(source="flight_id")  # noqa: N815
    kind = serializers.CharField(source="type")
    requestedTimeUtc = serializers.DateTimeField(source="requested_utc")  # noqa: N815
    confirmedTimeUtc = serializers.DateTimeField(  # noqa: N815
        source="confirmed_utc", allow_null=True
    )
    messageRef = serializers.CharField(source="message_number", allow_blank=True)  # noqa: N815

    class Meta:
        model = Slot
        fields = (
            "id", "airportIcao", "flightId", "kind", "requestedTimeUtc",
            "confirmedTimeUtc", "status", "messageRef", "comment",
        )


class SlotCreateSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """`SlotCreate` из контракта."""

    flightId = serializers.CharField()  # noqa: N815
    airportIcao = serializers.RegexField(r"^[A-Za-z]{4}$")  # noqa: N815
    kind = serializers.ChoiceField(choices=["arrival", "departure"])
    requestedTimeUtc = serializers.DateTimeField()  # noqa: N815


class SlotMessageSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Черновик сообщения координатору."""

    messageRef = serializers.CharField()  # noqa: N815
    text = serializers.CharField()


class SlotAnswerSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Ответ координатора: текст письма и/или решение диспетчера."""

    text = serializers.CharField(required=False, allow_blank=True, default="")
    status = serializers.ChoiceField(
        choices=["confirmed", "rejected"], required=False, allow_blank=True, default=""
    )
    confirmedTimeUtc = serializers.DateTimeField(  # noqa: N815
        required=False, allow_null=True, default=None
    )


def conflict_payload(flight: Flight, item: conflict_detector.Conflict) -> dict[str, Any]:
    """Конфликт в форме контракта."""
    # Неисправный борт и пересечение рейсов — разного веса: первое срывает
    # рейс, второе чаще всего улаживается сдвигом расписания.
    critical = item.kind in ("aircraft_aog", "overlap")
    return {
        "kind": item.kind,
        "flightId": flight.pk,
        "relatedFlightId": item.related_flight_id,
        "message": item.message,
        "severity": "critical" if critical else "warning",
    }
