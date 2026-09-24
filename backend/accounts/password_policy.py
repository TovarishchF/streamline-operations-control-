"""Политика паролей `[ТЗ 4.3]`.

Проверка стоит в `AUTH_PASSWORD_VALIDATORS`, а не в форме регистрации:
правило должно быть одним для всех путей, которыми пароль попадает
в систему — регистрации, смены пароля и заведения учётной записи
администратором. Правило, записанное в одной форме из трёх, — это
не политика, а украшение одного экрана.
"""

from __future__ import annotations

import string
from typing import TYPE_CHECKING

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _

if TYPE_CHECKING:
    from accounts.models import User

# Разрешённые знаки препинания.
#
# Пароль хэшируется и никуда не подставляется, так что «сломать систему»
# никакой символ не может — обрезаны те, что путаются при переносе:
# кавычки и апостроф подменяются на типографские редакторами и мобильными
# клавиатурами, обратная косая и вертикальная черта теряются при пересылке
# через терминал и таблицы, угловые скобки съедаются вставкой в разметку.
# При минимуме в двенадцать знаков на стойкости это не сказывается.
SPECIAL = "!@#$%^&*()-_=+[]{}:;,.?~"

ALLOWED = set(string.ascii_letters + string.digits + SPECIAL)


class ComplexityValidator:
    """Буквы, цифры и хотя бы один знак препинания."""

    def validate(self, password: str, user: User | None = None) -> None:
        if not any(char.isalpha() for char in password):
            raise ValidationError(
                _("Пароль должен содержать буквы."), code="password_no_letter"
            )
        if not any(char.isdigit() for char in password):
            raise ValidationError(
                _("Пароль должен содержать цифры."), code="password_no_digit"
            )
        if not any(char in SPECIAL for char in password):
            raise ValidationError(
                _("Пароль должен содержать хотя бы один знак препинания: %(special)s"),
                code="password_no_special",
                params={"special": SPECIAL},
            )

    def get_help_text(self) -> str:
        return _(
            "Пароль содержит буквы, цифры и хотя бы один знак препинания: %(special)s"
        ) % {"special": SPECIAL}


class AllowedCharactersValidator:
    """Отсекает знаки, которые теряются при переносе пароля.

    Кириллица сюда тоже не проходит: пароль, набранный в русской
    раскладке, невозможно ввести на чужой клавиатуре, а вспоминают
    об этом уже в аэропорту.
    """

    def validate(self, password: str, user: User | None = None) -> None:
        wrong = sorted({char for char in password if char not in ALLOWED})
        if wrong:
            raise ValidationError(
                _("Эти знаки в пароле использовать нельзя: %(wrong)s"),
                code="password_forbidden_characters",
                params={"wrong": " ".join(wrong)},
            )

    def get_help_text(self) -> str:
        return _("Латинские буквы, цифры и знаки препинания %(special)s") % {
            "special": SPECIAL
        }
