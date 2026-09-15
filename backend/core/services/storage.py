"""Объектное хранилище: подписанные ссылки на загрузку и скачивание.

ADR-007: вложения живут только в S3-совместимом хранилище. Файл идёт
из браузера прямо в хранилище по подписанной ссылке, минуя приложение:
двадцатимегабайтный скан договора не должен занимать воркер gunicorn
на всё время загрузки.

Подпись SigV4 покрывает заголовок `Host`, поэтому ссылка подписывается
для того адреса, по которому к хранилищу обратится **браузер**
(`S3_PUBLIC_ENDPOINT`), а не для внутреннего имени сети Docker. Подменить
host в уже подписанной ссылке нельзя — подпись перестанет сходиться.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from django.conf import settings

from core.clock import now
from core.exceptions import DomainError

if TYPE_CHECKING:
    from datetime import datetime

# Срок жизни подписанной ссылки. Пятнадцати минут хватает на загрузку
# файла предельного размера по медленному каналу и мало для того, чтобы
# утёкшая из журнала ссылка была кому-то полезна.
UPLOAD_URL_TTL_SECONDS = 15 * 60
DOWNLOAD_URL_TTL_SECONDS = 15 * 60


class AttachmentRejected(DomainError):
    """Вложение не принято: тип или размер вне допустимого."""

    code = "VALIDATION_ERROR"


class AttachmentNotUploaded(DomainError):
    """Подтверждение загрузки без файла в хранилище."""

    code = "VALIDATION_ERROR"


def _options() -> dict[str, Any]:
    storages: dict[str, Any] = settings.STORAGES
    options: dict[str, Any] = storages["default"]["OPTIONS"]
    return options


def bucket_name() -> str:
    return str(_options()["bucket_name"])


@lru_cache(maxsize=2)
def _client(public: bool) -> Any:
    """Клиент хранилища. Два адреса: внутренний и тот, что видит браузер.

    Кэшируется: создание клиента boto3 разбирает описания сервисов и стоит
    десятки миллисекунд, а на каждый запрос это лишнее.
    """
    options = _options()
    endpoint = (
        settings.S3_PUBLIC_ENDPOINT if public else options["endpoint_url"]
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=options["access_key"],
        aws_secret_access_key=options["secret_key"],
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def ensure_bucket() -> None:
    """Создаёт бакет, если его ещё нет.

    Идемпотентно: повторный вызов ничего не делает. Нужно на свежем стенде,
    где хранилище поднялось пустым.
    """
    client = _client(public=False)
    try:
        client.head_bucket(Bucket=bucket_name())
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket"):
            raise
        client.create_bucket(Bucket=bucket_name())


def validate(*, mime_type: str, size_bytes: int) -> None:
    """Проверка типа и размера до выдачи ссылки.

    Отказ выдаётся до загрузки, а не после: сообщать человеку, что
    двадцать мегабайт, которые он только что отправил, не приняты, —
    худший из возможных моментов.
    """
    if mime_type not in settings.ALLOWED_ATTACHMENT_TYPES:
        allowed = ", ".join(settings.ALLOWED_ATTACHMENT_TYPES)
        raise AttachmentRejected(
            f"Тип файла {mime_type} не принимается. Допустимы: {allowed}",
            {"mimeType": mime_type},
        )
    if size_bytes <= 0:
        raise AttachmentRejected("Пустой файл не принимается", {"sizeBytes": size_bytes})
    if size_bytes > settings.MAX_ATTACHMENT_SIZE_BYTES:
        limit_mb = settings.MAX_ATTACHMENT_SIZE_BYTES // (1024 * 1024)
        raise AttachmentRejected(
            f"Файл больше {limit_mb} МБ не принимается",
            {"sizeBytes": size_bytes, "limitBytes": settings.MAX_ATTACHMENT_SIZE_BYTES},
        )


_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(file_name: str) -> str:
    """Имя файла, пригодное для ключа в бакете.

    Кириллица транслитерируется отбрасыванием диакритики и заменой
    остального на дефис: ключ объекта участвует в подписи и в URL,
    и произвольный юникод там источник трудноуловимых расхождений.
    Исходное имя сохраняется в записи и показывается человеку.
    """
    normalized = unicodedata.normalize("NFKD", file_name)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = _UNSAFE.sub("-", ascii_only).strip("-.")
    return cleaned[:120] or "file"


def build_key(*, prefix: str, attachment_id: str, file_name: str) -> str:
    """Ключ объекта: раскладка по типу владельца и дате.

    Дата в пути нужна не для поиска, а для правил жизненного цикла бакета
    и для того, чтобы каталог не превращался в один плоский список на
    сотни тысяч объектов.
    """
    stamp: datetime = now()
    return f"{prefix}/{stamp:%Y/%m}/{attachment_id}/{safe_name(file_name)}"


def presign_put(*, key: str, mime_type: str) -> str:
    """Ссылка для загрузки файла браузером (HTTP PUT)."""
    ensure_bucket()
    url: str = _client(public=True).generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket_name(), "Key": key, "ContentType": mime_type},
        ExpiresIn=UPLOAD_URL_TTL_SECONDS,
    )
    return url


def presign_get(*, key: str, file_name: str) -> str:
    """Ссылка для скачивания.

    `response-content-disposition` возвращает человеку исходное имя файла,
    а не транслитерированный ключ.
    """
    url: str = _client(public=True).generate_presigned_url(
        "get_object",
        Params={
            "Bucket": bucket_name(),
            "Key": key,
            "ResponseContentDisposition": f'attachment; filename="{safe_name(file_name)}"',
        },
        ExpiresIn=DOWNLOAD_URL_TTL_SECONDS,
    )
    return url


def object_size(key: str) -> int | None:
    """Размер объекта в хранилище либо `None`, если его там нет."""
    try:
        head = _client(public=False).head_object(Bucket=bucket_name(), Key=key)
    except ClientError:
        return None
    return int(head["ContentLength"])


def put_bytes(*, key: str, data: bytes, mime_type: str) -> None:
    """Запись объекта со стороны сервера.

    Нужна для того, что формирует сам сервер: печатные формы, выгрузки.
    Пользовательские файлы идут мимо приложения, по подписанной ссылке.
    """
    ensure_bucket()
    _client(public=False).put_object(
        Bucket=bucket_name(), Key=key, Body=data, ContentType=mime_type
    )


def get_bytes(key: str) -> bytes:
    """Чтение объекта на стороне сервера.

    Нужно там, где файл обрабатывает сам сервер: вложение письма читается,
    чтобы уйти в SMTP. Пользователю файл по-прежнему отдаётся подписанной
    ссылкой, минуя приложение.
    """
    response = _client(public=False).get_object(Bucket=bucket_name(), Key=key)
    payload: bytes = response["Body"].read()
    return payload


def delete_object(key: str) -> None:
    _client(public=False).delete_object(Bucket=bucket_name(), Key=key)
