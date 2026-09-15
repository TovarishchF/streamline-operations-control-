"""Коммуникации `[ТЗ 3.5]` (`SPEC.md § 8`, `BACKEND.md § 3`).

Четыре сущности: шаблон сообщения, внутреннее уведомление, исходящее
и входящее сообщение.

Исходящее хранится **целиком** — канал, получатели, тема, уже собранное
тело, вложения, статус, число попыток и текст ошибки (`SPEC.md § 8.2`).
Хранить ссылку на шаблон и данные для подстановки было бы дешевле, но
тогда письмо, отправленное полгода назад, восстанавливалось бы по
сегодняшнему шаблону — и переписка с поставщиком перестала бы
соответствовать тому, что он получил.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.contrib.contenttypes.fields import GenericRelation
from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import BaseModel


class MessageChannel(models.TextChoices):
    EMAIL = "email", _("Электронная почта")
    MESSENGER = "messenger", _("Мессенджер")
    PORTAL = "portal", _("Портал")


class OutboxStatus(models.TextChoices):
    QUEUED = "queued", _("В очереди")
    SENT = "sent", _("Отправлено")
    DELIVERED = "delivered", _("Доставлено")
    FAILED = "failed", _("Ошибка")


class NotificationKind(models.TextChoices):
    """События из `SPEC.md § 8.1`. Перечень закрыт: подписка настраивается
    по типу, и тип, которого нет в списке, настроить нельзя."""

    FLIGHT_STATUS = "flight_status", _("Смена статуса рейса")
    SERVICE_CONFIRMED = "service_confirmed", _("Заявка подтверждена")
    SERVICE_REJECTED = "service_rejected", _("Заявка отклонена")
    DEADLINE = "deadline", _("Приближение срока")
    SLA_BREACH = "sla_breach", _("Нарушение SLA")
    CONTRACT_EXPIRY = "contract_expiry", _("Истечение контракта")
    PAYMENT_OVERDUE = "payment_overdue", _("Просрочка оплаты")
    LOW_MARGIN = "low_margin", _("Низкая маржа")


class NotificationSeverity(models.TextChoices):
    INFO = "info", _("Сведение")
    WARNING = "warning", _("Предупреждение")
    CRITICAL = "critical", _("Критично")


class MessageTemplate(BaseModel):
    """Шаблон исходящего сообщения `[ТЗ 3.5.2]`.

    Тема и тело хранятся на двух языках: язык письма выбирается по локали
    получателя (`SPEC.md § 8.2`). Переводить шаблон на лету нечем —
    это текст, составленный человеком, а не строка интерфейса.
    """

    id_prefix: ClassVar[str] = "tpl"

    code = models.CharField(max_length=48, unique=True)
    channel = models.CharField(max_length=16, choices=MessageChannel.choices)

    subject_ru = models.CharField(max_length=255)
    subject_en = models.CharField(max_length=255)
    body_ru = models.TextField()
    body_en = models.TextField()

    # Перечень допустимых подстановок. Хранится, чтобы редактор шаблона
    # показывал их списком, а проверка могла отказать в переменной,
    # которой при отправке не окажется.
    variables = models.JSONField(default=list, blank=True)

    class Meta:
        verbose_name = _("Шаблон сообщения")
        verbose_name_plural = _("Шаблоны сообщений")
        ordering = ("code",)

    def __str__(self) -> str:
        return self.code

    def subject_for(self, locale: str) -> str:
        return self.subject_en if locale == "en" else self.subject_ru

    def body_for(self, locale: str) -> str:
        return self.body_en if locale == "en" else self.body_ru


class Notification(BaseModel):
    """Внутреннее уведомление `[ТЗ 3.5.1]`."""

    id_prefix: ClassVar[str] = "ntf"

    user = models.ForeignKey(
        "accounts.User", on_delete=models.CASCADE, related_name="notifications"
    )
    kind = models.CharField(max_length=24, choices=NotificationKind.choices, db_index=True)
    severity = models.CharField(
        max_length=8, choices=NotificationSeverity.choices, default=NotificationSeverity.INFO
    )

    title = models.CharField(max_length=255)
    body = models.TextField(blank=True)
    # Ссылка на экран системы, а не на внешний адрес: уведомление ведёт
    # туда, где событие можно разобрать.
    link = models.CharField(max_length=255, blank=True)

    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Уведомление")
        verbose_name_plural = _("Уведомления")
        ordering = ("-created_at", "-id")
        indexes = (
            # Колокольчик считает непрочитанные у текущего пользователя —
            # это самый частый запрос экрана.
            models.Index(
                fields=("user", "-created_at"),
                condition=models.Q(read_at__isnull=True),
                name="notification_unread_idx",
            ),
        )

    def __str__(self) -> str:
        return f"{self.kind}: {self.title}"


class OutboxMessage(BaseModel):
    """Исходящее сообщение `[ТЗ 3.5.2]`."""

    id_prefix: ClassVar[str] = "out"

    channel = models.CharField(max_length=16, choices=MessageChannel.choices, db_index=True)
    # Фактический режим подключения на момент отправки. Записывается,
    # а не вычисляется при показе: настройку меняют, а история отправок
    # обязана честно говорить, ушло сообщение наружу или нет
    # (`CLAUDE.md § 4`).
    channel_mode = models.CharField(max_length=8, blank=True)

    # [{"name": ..., "address": ..., "locale": ...}]
    to = models.JSONField(default=list)

    template_code = models.CharField(max_length=48, blank=True)
    subject = models.CharField(max_length=255)
    body = models.TextField()

    related_entity_type = models.CharField(max_length=24, blank=True)
    related_entity_id = models.CharField(max_length=40, blank=True, db_index=True)

    status = models.CharField(
        max_length=12, choices=OutboxStatus.choices, default=OutboxStatus.QUEUED, db_index=True
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.TextField(blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    # Следующая попытка отправки. Пустое значение — отправлять сейчас.
    # Задержка растёт экспоненциально (`BACKEND.md § 5`): почтовый сервер,
    # отказавший трижды подряд, не станет отвечать чаще от того, что
    # к нему постучатся ещё раз через секунду.
    next_attempt_at = models.DateTimeField(null=True, blank=True, db_index=True)

    # Вложения письма: PDF котировки, счёта, заявки (`SPEC.md § 8.2`).
    # Те же вложения, что у остальных сущностей, — общий механизм,
    # а не своё хранилище файлов на каждый модуль.
    attachments = GenericRelation(
        "core.Attachment", content_type_field="content_type", object_id_field="object_id"
    )

    # Ключ файла `.eml` в объектном хранилище. Наружу отдаётся подписанной
    # ссылкой, а не путём: путь без подписи бесполезен, а ссылка живёт
    # четверть часа и её нельзя положить в закладки.
    eml_key = models.CharField(max_length=512, blank=True)

    class Meta:
        verbose_name = _("Исходящее сообщение")
        verbose_name_plural = _("Исходящие")
        ordering = ("-created_at", "-id")
        indexes = (
            models.Index(
                fields=("next_attempt_at",),
                condition=models.Q(status="queued"),
                name="outbox_due_idx",
            ),
        )

    def __str__(self) -> str:
        return f"{self.channel}: {self.subject}"


class InboxMessage(BaseModel):
    """Входящее внешнее событие `[ТЗ 3.2.2]` (`SPEC.md § 8.3`).

    Нераспознанное входящее — штатный сценарий, а не ошибка
    (`INTEGRATIONS.md § 3.3`). Поэтому `recognized` — обычное поле,
    а не признак сбоя, и запись с `recognized=False` не требует
    вмешательства администратора, только разбора диспетчером.
    """

    id_prefix: ClassVar[str] = "inb"

    channel = models.CharField(
        max_length=16, choices=MessageChannel.choices, default=MessageChannel.EMAIL
    )
    sender = models.CharField(max_length=255, blank=True)
    subject = models.CharField(max_length=255, blank=True)
    body = models.TextField(blank=True)
    received_at = models.DateTimeField(db_index=True)

    recognized = models.BooleanField(default=False, db_index=True)
    service_order = models.ForeignKey(
        "orders.ServiceOrder",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inbox_messages",
    )
    # Переход автомата заявки, который предлагает разбор. Хранится строкой:
    # это предложение, а не команда, и применяет его человек.
    suggested_action = models.CharField(max_length=32, blank=True)

    applied_at = models.DateTimeField(null=True, blank=True)
    applied_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="applied_inbox_messages",
    )

    # Идентификатор письма у источника: по нему повторная выборка из ящика
    # не заводит второе входящее (`BACKEND.md § 5`, задачи идемпотентны).
    external_id = models.CharField(max_length=255, blank=True, unique=True, null=True)

    class Meta:
        verbose_name = _("Входящее сообщение")
        verbose_name_plural = _("Входящие")
        ordering = ("-received_at", "-id")

    def __str__(self) -> str:
        return f"{self.sender}: {self.subject}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Пустая строка в уникальном поле столкнулась бы со второй пустой,
        # а NULL в PostgreSQL уникальности не нарушает.
        if not self.external_id:
            self.external_id = None
        super().save(*args, **kwargs)

