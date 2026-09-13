"""Поля сериализаторов, общие для нескольких модулей.

`LocalizedName` в контракте — объект `{ru, en}`. В базе это два поля
(ADR-031), поэтому нужен переходник: контракт согласован с клиентами
до кода и подстраивать его под форму хранения нельзя.
"""

from __future__ import annotations

from typing import Any

from django.utils.translation import get_language
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers


@extend_schema_field(
    {
        "type": "object",
        "required": ["ru", "en"],
        "properties": {"ru": {"type": "string"}, "en": {"type": "string"}},
    }
)
class LocalizedNameField(serializers.Field):  # type: ignore[type-arg]
    """Пара полей `<prefix>_ru` и `<prefix>_en` как объект `{ru, en}`."""

    def __init__(self, prefix: str = "name", **kwargs: Any) -> None:
        self.prefix = prefix
        kwargs.setdefault("source", "*")
        super().__init__(**kwargs)

    def to_representation(self, value: Any) -> dict[str, str]:
        return {
            "ru": getattr(value, f"{self.prefix}_ru", ""),
            "en": getattr(value, f"{self.prefix}_en", ""),
        }

    def to_internal_value(self, data: Any) -> dict[str, str]:
        if not isinstance(data, dict) or "ru" not in data or "en" not in data:
            raise serializers.ValidationError(
                "Ожидается объект с наименованиями на двух языках: {\"ru\": …, \"en\": …}"
            )
        return {f"{self.prefix}_ru": data["ru"], f"{self.prefix}_en": data["en"]}


@extend_schema_field({"type": "string"})
class LocalizedTextField(serializers.Field):  # type: ignore[type-arg]
    """Одно из двух полей по языку запроса.

    Контракт объявляет `city` строкой, а не парой: на экране город нужен
    один, на языке пользователя. Хранятся оба, отдаётся подходящий.
    """

    def __init__(self, prefix: str, **kwargs: Any) -> None:
        self.prefix = prefix
        kwargs.setdefault("source", "*")
        kwargs.setdefault("read_only", True)
        super().__init__(**kwargs)

    def to_representation(self, value: Any) -> str:
        language = (get_language() or "ru").split("-")[0]
        suffix = "ru" if language == "ru" else "en"
        text: str = getattr(value, f"{self.prefix}_{suffix}", "")
        # Русского наименования может не быть: в открытых источниках они
        # есть не везде, и подставлять транслитерацию было бы выдумкой.
        return text or getattr(value, f"{self.prefix}_en", "")

    def to_internal_value(self, data: Any) -> Any:
        raise NotImplementedError
