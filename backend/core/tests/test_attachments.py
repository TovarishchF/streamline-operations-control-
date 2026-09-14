"""Вложения: подписанная ссылка, подтверждение, привязка к договору.

Хранилище подменено на заглушку в памяти: тест проверяет порядок
и проверки, а не работу MinIO. Настоящий обмен с хранилищем проверяется
отдельно, помеченным `integration`.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest
from rest_framework import status

from accounts.models import Role
from core.clock import now
from core.models import Attachment, AttachmentKind
from core.services import storage

if TYPE_CHECKING:
    from collections.abc import Callable

    from rest_framework.test import APIClient

    from counterparties.models import Vendor

pytestmark = pytest.mark.django_db

ATTACHMENTS_URL = "/api/v1/attachments"
CONTRACTS_URL = "/api/v1/contracts"

PDF = "application/pdf"


class FakeBucket:
    """Хранилище в памяти: ключ → размер."""

    def __init__(self) -> None:
        self.objects: dict[str, int] = {}

    def size(self, key: str) -> int | None:
        return self.objects.get(key)


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> FakeBucket:
    """Подменяет обмен с хранилищем, оставляя проверки и порядок настоящими."""
    fake = FakeBucket()

    monkeypatch.setattr(storage, "ensure_bucket", lambda: None)
    monkeypatch.setattr(
        storage,
        "presign_put",
        lambda *, key, mime_type: f"http://storage.test/{key}?signature=test",
    )
    monkeypatch.setattr(
        storage,
        "presign_get",
        lambda *, key, file_name: f"http://storage.test/{key}?download=1",
    )
    monkeypatch.setattr(storage, "object_size", fake.size)
    return fake


def reserve_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "fileName": "Договор ДГ-2026-0417.pdf",
        "mimeType": PDF,
        "sizeBytes": 248_000,
        "kind": AttachmentKind.CONTRACT,
    }
    payload.update(overrides)
    return payload


def test_reserve_returns_upload_url_and_pending_attachment(
    as_role: Callable[..., APIClient], bucket: FakeBucket
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(ATTACHMENTS_URL, reserve_payload(), format="json")

    assert response.status_code == status.HTTP_201_CREATED, response.data
    body = response.json()
    assert body["uploadUrl"].startswith("http://storage.test/contracts/")
    # Файла ещё нет: ссылки на скачивание тоже нет
    assert body["attachment"]["uploadedAt"] is None
    assert body["attachment"]["downloadUrl"] is None
    # Исходное имя сохранено, в ключе — транслитерация
    assert body["attachment"]["fileName"] == "Договор ДГ-2026-0417.pdf"
    assert "0417.pdf" in body["attachment"]["storageKey"]


def test_disallowed_mime_type_is_rejected_before_upload(
    as_role: Callable[..., APIClient], bucket: FakeBucket
) -> None:
    """Отказ до загрузки: сообщать об отказе после отправки файла — поздно."""
    api = as_role(Role.FINANCE)
    response = api.post(
        ATTACHMENTS_URL,
        reserve_payload(mimeType="application/x-msdownload"),
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert Attachment.objects.count() == 0


def test_oversized_file_is_rejected_before_upload(
    as_role: Callable[..., APIClient], bucket: FakeBucket
) -> None:
    api = as_role(Role.FINANCE)
    response = api.post(
        ATTACHMENTS_URL, reserve_payload(sizeBytes=99_000_000), format="json"
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_confirm_without_uploaded_file_fails(
    as_role: Callable[..., APIClient], bucket: FakeBucket
) -> None:
    """Оборванная загрузка не должна оставить в договоре ссылку в никуда."""
    api = as_role(Role.FINANCE)
    reserved = api.post(ATTACHMENTS_URL, reserve_payload(), format="json").json()

    response = api.post(f"{ATTACHMENTS_URL}/{reserved['attachment']['id']}/confirm")
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert Attachment.objects.get(pk=reserved["attachment"]["id"]).uploaded_at is None


def test_confirm_takes_actual_size_from_storage(
    as_role: Callable[..., APIClient], bucket: FakeBucket
) -> None:
    """Заявленный размер служил проверкой лимита; в записи — фактический."""
    api = as_role(Role.FINANCE)
    reserved = api.post(ATTACHMENTS_URL, reserve_payload(), format="json").json()
    bucket.objects[reserved["attachment"]["storageKey"]] = 251_904

    confirmed = api.post(f"{ATTACHMENTS_URL}/{reserved['attachment']['id']}/confirm")
    assert confirmed.status_code == status.HTTP_200_OK
    body = confirmed.json()
    assert body["sizeBytes"] == 251_904
    assert body["uploadedAt"] is not None
    assert body["downloadUrl"].startswith("http://storage.test/")


def test_cannot_confirm_someone_elses_attachment(
    as_role: Callable[..., APIClient],
    make_user: Callable[..., Any],
    bucket: FakeBucket,
) -> None:
    """Чужой идентификатор не должен давать подписанную ссылку на чужой файл."""
    api = as_role(Role.FINANCE)
    reserved = api.post(ATTACHMENTS_URL, reserve_payload(), format="json").json()
    bucket.objects[reserved["attachment"]["storageKey"]] = 100

    api.force_authenticate(user=make_user(Role.FINANCE, suffix="other"))
    response = api.post(f"{ATTACHMENTS_URL}/{reserved['attachment']['id']}/confirm")
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_contract_carries_confirmed_attachment(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor, bucket: FakeBucket
) -> None:
    """Сквозной путь кнопки «Загрузить договор»."""
    api = as_role(Role.FINANCE)

    reserved = api.post(ATTACHMENTS_URL, reserve_payload(), format="json").json()
    bucket.objects[reserved["attachment"]["storageKey"]] = 248_000
    api.post(f"{ATTACHMENTS_URL}/{reserved['attachment']['id']}/confirm")

    start = now()
    created = api.post(
        CONTRACTS_URL,
        {
            "vendorId": vendor_alpha.pk,
            "number": "ДГ-2026-0417",
            "validFrom": start.isoformat(),
            "validTo": (start + timedelta(days=365)).isoformat(),
            "currency": "RUB",
            "paymentTerms": {"mode": "deferred", "deferDays": 14},
            "attachmentIds": [reserved["attachment"]["id"]],
        },
        format="json",
        headers={"Idempotency-Key": "contract-att-01"},
    )

    assert created.status_code == status.HTTP_201_CREATED, created.data
    attachments = created.json()["attachments"]
    assert len(attachments) == 1
    assert attachments[0]["fileName"] == "Договор ДГ-2026-0417.pdf"
    assert attachments[0]["kind"] == AttachmentKind.CONTRACT
    assert attachments[0]["downloadUrl"].startswith("http://storage.test/")


def test_unconfirmed_attachment_is_not_linked_to_contract(
    as_role: Callable[..., APIClient], vendor_alpha: Vendor, bucket: FakeBucket
) -> None:
    """В договор попадает только то, что действительно лежит в хранилище."""
    api = as_role(Role.FINANCE)
    reserved = api.post(ATTACHMENTS_URL, reserve_payload(), format="json").json()

    start = now()
    created = api.post(
        CONTRACTS_URL,
        {
            "vendorId": vendor_alpha.pk,
            "number": "ДГ-2026-0418",
            "validFrom": start.isoformat(),
            "validTo": (start + timedelta(days=365)).isoformat(),
            "currency": "RUB",
            "paymentTerms": {"mode": "deferred", "deferDays": 14},
            "attachmentIds": [reserved["attachment"]["id"]],
        },
        format="json",
        headers={"Idempotency-Key": "contract-att-02"},
    )
    assert created.json()["attachments"] == []


def test_cyrillic_file_name_becomes_safe_storage_key() -> None:
    """Ключ объекта участвует в подписи — произвольный юникод там источник расхождений.

    Кириллица отбрасывается, а знаки, у которых есть совместимое разложение
    (`№` → `No`), сохраняются: разложение NFKD делает это само, и подавлять
    его незачем — результат остаётся читаемым.
    """
    assert storage.safe_name("Договор № 17/2026.pdf") == "No-17-2026.pdf"
    # Имя целиком из кириллицы вырождается в расширение — это допустимо:
    # человеку показывается исходное имя, ключ нужен только хранилищу.
    assert storage.safe_name("Договор.pdf") == "pdf"
    assert storage.safe_name("") == "file"
