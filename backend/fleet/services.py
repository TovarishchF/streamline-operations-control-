"""Операции над парком воздушных судов `[ТЗ 3.1.3]`."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType
from fleet.models import Aircraft, AircraftApproval

if TYPE_CHECKING:
    from accounts.models import User


@transaction.atomic
def add_aircraft(*, data: dict[str, Any], actor: User) -> Aircraft:
    """Ставит борт в парк вместе с допусками.

    Допуски создаются в той же транзакции: борт без допуска ETOPS ведёт себя
    в проверке конфликтов иначе, чем борт с ним (ADR-027), и промежуточное
    состояние «борт уже есть, допусков ещё нет» успело бы попасть в выборку.
    """
    aircraft = Aircraft.objects.create(
        registration=data["registration"],
        type_id=data["typeId"],
        operator_id=data.get("operatorId"),
        home_base_icao=data["homeBaseIcao"],
        status=data["status"],
        notes=data.get("notes", ""),
    )

    for approval in data.get("approvals", []):
        AircraftApproval.objects.create(
            aircraft=aircraft,
            kind=approval["kind"],
            number=approval.get("number", ""),
            valid_from=approval["valid_from"],
            valid_to=approval["valid_to"],
        )

    audit.record(
        entity_type=AuditEntityType.AIRCRAFT,
        entity_id=aircraft.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(aircraft),
    )
    return aircraft
