"""Операции над контрагентами `[ТЗ 3.3]`.

`BACKEND.md § 3.1`: бизнес-логика живёт здесь, а не во вьюхах и не
в сериализаторах. Каждая операция — именованные аргументы, явный `actor`,
транзакция, запись в аудит внутри той же транзакции.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.db import transaction

from audit import services as audit
from audit.models import AuditEntityType
from core.models import AttachmentKind
from core.services import attachments as attachment_service
from counterparties.models import Client, Contact, Vendor, VendorCertificate, VendorContract

if TYPE_CHECKING:
    from datetime import datetime
    from decimal import Decimal

    from accounts.models import Organization, User


def _sync_contacts(*, owner: Client | Vendor, contacts: list[dict[str, Any]]) -> None:
    """Пересоздаёт набор контактов владельца.

    Контакты правятся целым списком, а не поодиночке: в интерфейсе это
    одна таблица в карточке, и частичное обновление породило бы вопрос,
    что делать со строкой, которой в присланном списке нет.
    """
    owner.contacts.all().delete()
    field = "client" if isinstance(owner, Client) else "vendor"
    for contact in contacts:
        Contact.objects.create(
            **{field: owner},
            name=contact["name"],
            role=contact.get("role", ""),
            email=contact["email"],
            phone=contact.get("phone") or "",
            locale=contact.get("locale", "ru"),
            is_primary=contact.get("isPrimary", False),
        )


@transaction.atomic
def create_client(
    *,
    organization: Organization,
    name: str,
    legal_name: str,
    country: str,
    settlement_currency: str,
    payment_mode: str,
    payment_defer_days: int,
    payment_prepayment_percent: Decimal | None,
    default_locale: str,
    credit_limit_amount: Decimal | None,
    credit_limit_currency: str,
    contacts: list[dict[str, Any]],
    actor: User,
) -> Client:
    """Заводит клиента `[ТЗ 3.3]`."""
    client = Client.objects.create(
        organization=organization,
        name=name,
        legal_name=legal_name,
        country=country,
        settlement_currency=settlement_currency,
        payment_mode=payment_mode,
        payment_defer_days=payment_defer_days,
        payment_prepayment_percent=payment_prepayment_percent,
        default_locale=default_locale,
        credit_limit_amount=credit_limit_amount,
        credit_limit_currency=credit_limit_currency,
    )
    _sync_contacts(owner=client, contacts=contacts)

    audit.record(
        entity_type=AuditEntityType.CLIENT,
        entity_id=client.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(client),
    )
    return client


@transaction.atomic
def update_client(*, client: Client, changes: dict[str, Any], actor: User) -> Client:
    before = audit.snapshot(client)
    contacts = changes.pop("contacts", None)

    for field, value in changes.items():
        setattr(client, field, value)
    client.save()

    if contacts is not None:
        _sync_contacts(owner=client, contacts=contacts)

    audit.record(
        entity_type=AuditEntityType.CLIENT,
        entity_id=client.pk,
        action="updated",
        actor=actor,
        before=before,
        after=audit.snapshot(client),
    )
    return client


@transaction.atomic
def create_vendor(
    *,
    organization: Organization,
    name: str,
    legal_name: str,
    country: str,
    settlement_currency: str,
    specializations: list[str],
    coverage_airports: list[str],
    coverage_regions: list[str],
    payment_mode: str,
    payment_defer_days: int,
    payment_prepayment_percent: Decimal | None,
    manual_quality_score: int,
    exchange_method: str,
    contacts: list[dict[str, Any]],
    certificates: list[dict[str, Any]],
    actor: User,
) -> Vendor:
    """Заводит поставщика `[ТЗ 3.3.1]`."""
    vendor = Vendor.objects.create(
        organization=organization,
        name=name,
        legal_name=legal_name,
        country=country,
        settlement_currency=settlement_currency,
        specializations=specializations,
        coverage_airports=[code.upper() for code in coverage_airports],
        coverage_regions=coverage_regions,
        payment_mode=payment_mode,
        payment_defer_days=payment_defer_days,
        payment_prepayment_percent=payment_prepayment_percent,
        manual_quality_score=manual_quality_score,
        exchange_method=exchange_method,
    )
    _sync_contacts(owner=vendor, contacts=contacts)
    _sync_certificates(vendor=vendor, certificates=certificates)

    audit.record(
        entity_type=AuditEntityType.VENDOR,
        entity_id=vendor.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(vendor),
    )
    return vendor


def _sync_certificates(*, vendor: Vendor, certificates: list[dict[str, Any]]) -> None:
    vendor.certificates.all().delete()
    for certificate in certificates:
        VendorCertificate.objects.create(
            vendor=vendor,
            kind=certificate["kind"],
            number=certificate["number"],
            valid_from=certificate["validFrom"],
            valid_to=certificate["validTo"],
        )


@transaction.atomic
def update_vendor(*, vendor: Vendor, changes: dict[str, Any], actor: User) -> Vendor:
    before = audit.snapshot(vendor)
    contacts = changes.pop("contacts", None)
    certificates = changes.pop("certificates", None)

    for field, value in changes.items():
        setattr(vendor, field, value)
    vendor.save()

    if contacts is not None:
        _sync_contacts(owner=vendor, contacts=contacts)
    if certificates is not None:
        _sync_certificates(vendor=vendor, certificates=certificates)

    audit.record(
        entity_type=AuditEntityType.VENDOR,
        entity_id=vendor.pk,
        action="updated",
        actor=actor,
        before=before,
        after=audit.snapshot(vendor),
    )
    return vendor


@transaction.atomic
def create_contract(
    *,
    vendor: Vendor,
    number: str,
    valid_from: datetime,
    valid_to: datetime,
    currency: str,
    payment_mode: str,
    payment_defer_days: int,
    payment_prepayment_percent: Decimal | None,
    attachment_ids: list[str],
    actor: User,
) -> VendorContract:
    """Заводит договор с поставщиком `[ТЗ 3.3.3]`.

    Вложения уже лежат в хранилище: сюда приходят их идентификаторы,
    а не байты (ADR-007). Незавершённые загрузки отсеиваются при привязке.
    """
    contract = VendorContract.objects.create(
        vendor=vendor,
        number=number,
        valid_from=valid_from,
        valid_to=valid_to,
        currency=currency,
        payment_mode=payment_mode,
        payment_defer_days=payment_defer_days,
        payment_prepayment_percent=payment_prepayment_percent,
    )
    attachment_service.attach(attachment_ids=attachment_ids, owner=contract)
    # Вложение договора — это договор, каким бы ни был исходный вид файла:
    # признак задаёт раскладку в хранилище и фильтры в карточке.
    contract.attachments.update(kind=AttachmentKind.CONTRACT)

    audit.record(
        entity_type=AuditEntityType.CONTRACT,
        entity_id=contract.pk,
        action="created",
        actor=actor,
        after=audit.snapshot(contract),
        comment=f"Вложений: {len(attachment_ids)}",
    )
    return contract


@transaction.atomic
def terminate_contract(*, contract: VendorContract, at: datetime, actor: User) -> VendorContract:
    """Расторжение договора.

    Единственное, что не выводится из дат (G-42): договор могли прекратить
    досрочно, и статус обязан это показать.
    """
    before = audit.snapshot(contract)
    contract.terminated_at = at
    contract.save(update_fields=["terminated_at", "updated_at", "version"])

    audit.record(
        entity_type=AuditEntityType.CONTRACT,
        entity_id=contract.pk,
        action="terminated",
        actor=actor,
        before=before,
        after=audit.snapshot(contract),
    )
    return contract


def active_contract_for(*, vendor_id: str, moment: datetime) -> VendorContract | None:
    """Договор поставщика, действующий на указанный момент.

    Проверка заказа услуги (`SPEC.md § 5.2` п. 2) смотрит на дату оказания,
    а не на сегодняшнюю: заказ на послезавтра по договору, истекающему
    завтра, оформлять нельзя.
    """
    return (
        VendorContract.objects.filter(
            vendor_id=vendor_id,
            valid_from__lte=moment,
            valid_to__gte=moment,
            terminated_at__isnull=True,
        )
        .order_by("-valid_from")
        .first()
    )
