"""Журнал действий: неизменяемость и содержательный diff.

Критерий приёмки M3: «попытка `UPDATE` в таблице аудита из приложения падает
на уровне БД». Проверяется именно сырым SQL — через ORM запись защищена кодом,
а вопрос в том, что будет, если код обойти.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import connection, transaction
from django.db.utils import IntegrityError, InternalError, ProgrammingError

from accounts.models import Organization, Role, User
from audit import services
from audit.models import AuditEntityType, AuditEntry, AuditEntryImmutable, AuditSource
from catalog.models import VatRate
from core.models import DataSource

# psycopg отдаёт RAISE из триггера разными классами в зависимости от кода
# ошибки и версии драйвера. Для теста важно одно: операция не прошла.
DATABASE_REFUSAL = (InternalError, IntegrityError, ProgrammingError)


@pytest.fixture
def actor(db: None) -> User:
    organization = Organization.objects.create(name="Стримлайн Група")
    return User.objects.create(
        username="dispatcher1",
        first_name="Илья",
        last_name="Карпов",
        role=Role.DISPATCHER,
        organization=organization,
    )


@pytest.mark.django_db
class TestRecord:
    def test_keeps_only_changed_fields(self, actor: User) -> None:
        entry = services.record(
            entity_type=AuditEntityType.SETTINGS,
            entity_id="set_1",
            action="updated",
            actor=actor,
            before={"markup": "15.0000", "currency": "RUB"},
            after={"markup": "18.0000", "currency": "RUB"},
        )

        assert entry is not None
        assert entry.before == {"markup": "15.0000"}
        assert entry.after == {"markup": "18.0000"}

    def test_returns_nothing_when_value_did_not_change(self, actor: User) -> None:
        entry = services.record(
            entity_type=AuditEntityType.SETTINGS,
            entity_id="set_1",
            action="updated",
            actor=actor,
            before={"markup": "15.0000"},
            after={"markup": "15.0000"},
        )

        assert entry is None
        assert not AuditEntry.objects.exists()

    def test_creation_stores_whole_snapshot(self, actor: User) -> None:
        entry = services.record(
            entity_type=AuditEntityType.AIRPORT,
            entity_id="apt_1",
            action="created",
            actor=actor,
            after={"icao": "UUEE"},
        )

        assert entry is not None
        assert entry.before is None
        assert entry.after == {"icao": "UUEE"}

    def test_actor_details_are_snapshotted(self, actor: User) -> None:
        entry = services.record(
            entity_type=AuditEntityType.AIRPORT, entity_id="apt_1", action="created", actor=actor
        )

        assert entry is not None
        assert entry.actor_id == actor.pk
        assert entry.actor_name == "Илья Карпов"
        assert entry.actor_role == Role.DISPATCHER

    def test_generator_does_not_impersonate_a_person(self) -> None:
        """`CLAUDE.md § 4`: записи генератора видно, и они не выдаются за людей."""
        entry = services.record(
            entity_type=AuditEntityType.FLIGHT,
            entity_id="flt_1",
            action="created",
            source=AuditSource.SEED,
            is_demo=True,
        )

        assert entry is not None
        assert entry.source == AuditSource.SEED
        assert entry.actor_name == "System (демо-генератор)"
        assert entry.is_demo is True


@pytest.mark.django_db
class TestSnapshot:
    def test_decimal_becomes_string(self) -> None:
        """Деньги и проценты не проходят через float ни на одном уровне."""
        rate = VatRate(
            code="VAT20",
            name_ru="НДС 20 %",
            name_en="VAT 20%",
            percent=Decimal("20.0000"),
            applicability="domestic",
            data_source=DataSource.IMPORTED,
        )

        data = services.snapshot(rate)

        assert data["percent"] == "20.0000"
        assert not isinstance(data["percent"], float)

    def test_noise_fields_are_dropped(self) -> None:
        rate = VatRate(code="VAT0", percent=Decimal("0"), applicability="international")
        assert "version" not in services.snapshot(rate)
        assert "updated_at" not in services.snapshot(rate)


@pytest.mark.django_db(transaction=True)
class TestImmutability:
    def _entry(self) -> AuditEntry:
        entry = services.record(
            entity_type=AuditEntityType.FLIGHT,
            entity_id="flt_1",
            action="status_changed",
            after={"status": "planned"},
        )
        assert entry is not None
        return entry

    def test_orm_refuses_to_save_again(self) -> None:
        entry = self._entry()
        entry.action = "подделка"

        with pytest.raises(AuditEntryImmutable):
            entry.save()

    def test_orm_refuses_to_delete(self) -> None:
        entry = self._entry()

        with pytest.raises(AuditEntryImmutable):
            entry.delete()

    def test_raw_update_is_refused_by_the_database(self) -> None:
        """Главная проверка: код можно обойти, базу — нет."""
        entry = self._entry()

        with pytest.raises(DATABASE_REFUSAL), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "UPDATE audit_auditentry SET action = %s WHERE id = %s", ["подделка", entry.pk]
            )

        assert AuditEntry.objects.get(pk=entry.pk).action == "status_changed"

    def test_raw_delete_is_refused_by_the_database(self) -> None:
        entry = self._entry()

        with pytest.raises(DATABASE_REFUSAL), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("DELETE FROM audit_auditentry WHERE id = %s", [entry.pk])

        assert AuditEntry.objects.filter(pk=entry.pk).exists()

    def test_queryset_update_is_refused_by_the_database(self) -> None:
        """`QuerySet.update()` идёт мимо `save()` — его ловит триггер."""
        self._entry()

        with pytest.raises(DATABASE_REFUSAL), transaction.atomic():
            AuditEntry.objects.all().update(action="подделка")
