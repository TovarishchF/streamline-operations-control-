"""Вложения: заведение, подтверждение загрузки, привязка к владельцу.

Порядок ровно такой и не сокращается:

1. `reserve()` — запись заведена, ссылка на загрузку выдана, файла ещё нет;
2. браузер кладёт файл прямо в хранилище по подписанной ссылке;
3. `confirm()` — сервер убеждается, что объект появился, и только тогда
   вложение считается готовым;
4. `attach()` — готовое вложение связывается с договором, заявкой или счётом.

Шаг 3 не формальность: без него оборванная загрузка оставила бы в договоре
ссылку на несуществующий файл, и обнаружилось бы это через полгода, когда
договор понадобится.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.contrib.contenttypes.models import ContentType
from django.db import transaction

from core.clock import now
from core.models import Attachment, AttachmentKind, make_id
from core.services import storage

if TYPE_CHECKING:
    from django.db import models as django_models

    from accounts.models import User

# Раскладка в бакете по типу владельца: правила жизненного цикла
# и разбор инцидентов проще, когда договоры и акты лежат порознь.
PREFIX_BY_KIND: dict[str, str] = {
    AttachmentKind.CONTRACT: "contracts",
    AttachmentKind.ACT: "acts",
    AttachmentKind.RECEIPT: "receipts",
    AttachmentKind.INVOICE: "invoices",
    AttachmentKind.WAYBILL: "waybills",
    AttachmentKind.OTHER: "other",
}


@transaction.atomic
def reserve(
    *,
    file_name: str,
    mime_type: str,
    size_bytes: int,
    kind: str,
    actor: User,
) -> tuple[Attachment, str]:
    """Заводит вложение и возвращает его вместе со ссылкой на загрузку.

    Тип и размер проверяются здесь, до выдачи ссылки: отказывать после
    того, как человек уже отправил файл, — худший из возможных моментов.
    """
    storage.validate(mime_type=mime_type, size_bytes=size_bytes)

    attachment_id = make_id(Attachment.id_prefix)
    key = storage.build_key(
        prefix=PREFIX_BY_KIND.get(kind, "other"),
        attachment_id=attachment_id,
        file_name=file_name,
    )

    attachment = Attachment.objects.create(
        id=attachment_id,
        file_name=file_name,
        mime_type=mime_type,
        size_bytes=size_bytes,
        kind=kind,
        storage_key=key,
        uploaded_by=actor,
    )
    return attachment, storage.presign_put(key=key, mime_type=mime_type)


def confirm(*, attachment: Attachment) -> Attachment:
    """Отмечает загрузку состоявшейся, сверив размер с хранилищем.

    Размер берётся фактический: заявленный клиентом использовался только
    для проверки лимита до загрузки и мог не совпасть с тем, что дошло.
    """
    size = storage.object_size(attachment.storage_key)
    if size is None:
        raise storage.AttachmentNotUploaded(
            f"Файл {attachment.file_name} не найден в хранилище. "
            f"Загрузка не завершилась — повторите её.",
            {"attachmentId": attachment.pk},
        )

    attachment.size_bytes = size
    attachment.uploaded_at = now()
    attachment.save(update_fields=["size_bytes", "uploaded_at", "updated_at", "version"])
    return attachment


def attach(*, attachment_ids: list[str], owner: django_models.Model) -> list[Attachment]:
    """Привязывает загруженные вложения к владельцу.

    Незавершённые вложения (`uploaded_at is None`) отсеиваются: в договор
    попадает только то, что действительно лежит в хранилище.
    """
    if not attachment_ids:
        return []

    content_type = ContentType.objects.get_for_model(owner)
    attachments = list(
        Attachment.objects.filter(pk__in=attachment_ids, uploaded_at__isnull=False)
    )
    for attachment in attachments:
        attachment.content_type = content_type
        attachment.object_id = str(owner.pk)
        attachment.save(update_fields=["content_type", "object_id", "updated_at", "version"])
    return attachments


def link(*, attachment: Attachment, owner: django_models.Model) -> Attachment:
    """Привязывает одно вложение к владельцу, не дожидаясь загрузки.

    Нужно там, где вложение заводится сразу «для этой заявки»: акт,
    загруженный и не привязанный, не открыл бы переход в «Выполнена»,
    и разбираться с этим пришлось бы у стойки. Незавершённые вложения
    отсеиваются при чтении, по `uploaded_at`.
    """
    attachment.content_type = ContentType.objects.get_for_model(owner)
    attachment.object_id = str(owner.pk)
    attachment.save(update_fields=["content_type", "object_id", "updated_at", "version"])
    return attachment


def attach_stored(
    *,
    key: str,
    file_name: str,
    mime_type: str,
    kind: str,
    owner: django_models.Model,
) -> Attachment:
    """Вложение для файла, который сервер уже положил в хранилище.

    Порядок `reserve → confirm` описывает загрузку из браузера: ссылка,
    ожидание, сверка. Для выгрузки, собранной самим сервером, ждать нечего
    и сверять не с чем — файл записан этим же кодом. Размер берётся
    из хранилища, а не от вызывающего: считать его дважды значит завести
    второй источник истины.
    """
    size = storage.object_size(key)
    if size is None:
        raise storage.AttachmentNotUploaded(
            f"Файл {file_name} не найден в хранилище по ключу {key}.",
            {"key": key},
        )

    attachment = Attachment.objects.create(
        id=make_id(Attachment.id_prefix),
        file_name=file_name,
        mime_type=mime_type,
        size_bytes=size,
        kind=kind,
        storage_key=key,
        uploaded_at=now(),
        content_type=ContentType.objects.get_for_model(owner),
        object_id=str(owner.pk),
    )
    return attachment


def download_url(attachment: Attachment) -> str:
    return storage.presign_get(key=attachment.storage_key, file_name=attachment.file_name)
