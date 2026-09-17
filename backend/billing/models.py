"""Финансовые сущности `[ТЗ 3.4.1]`.

Курсы валют, тарифные правила клиентов, счётчик номеров, котировки, счета
и их строки. Заявки на оплату поставщикам и сверка — следующий слой той же
вехи (`TASKS.md` M7 пп. 6–7).

`INTEGRATIONS § 2.1`: курс запрашивается фоновой задачей раз в сутки
и **сохраняется в базу**. Документы ссылаются на сохранённую запись,
а не на провайдера: при недоступности источника система работает
на последнем известном курсе и выводит предупреждение.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db import models
from django.utils.translation import gettext_lazy as _

from core.models import BaseModel


class FxRate(BaseModel):
    """Курс валюты к рублю на дату (ADR-004).

    `rate` — сколько рублей стоит одна единица валюты. Номинал источника
    нормализован при загрузке.

    Знаков после запятой шесть, а не четыре, как у денег (ADR-002): курс —
    не сумма, а отношение, и округление отношения до четырёх знаков
    накапливает погрешность в произведении. Округление до денежной точности
    происходит один раз, на итоговой сумме.
    """

    id_prefix: ClassVar[str] = "fxr"

    on_date = models.DateField(db_index=True)
    currency = models.CharField(max_length=3)
    rate = models.DecimalField(max_digits=18, decimal_places=6)

    class Meta:
        verbose_name = _("Курс валюты")
        verbose_name_plural = _("Курсы валют")
        ordering = ("-on_date", "currency")
        constraints = (
            models.UniqueConstraint(fields=("on_date", "currency"), name="unique_fx_rate_per_day"),
        )

    def __str__(self) -> str:
        return f"{self.currency} {self.on_date:%d.%m.%Y}: {self.rate}"


class TariffMode(models.TextChoices):
    """Способ ценообразования (`DOMAIN.md § 6` ClientTariffRule)."""

    COST_PLUS = "cost_plus", _("Закупка плюс наценка")
    FIXED = "fixed", _("Фиксированная цена")
    PASS_THROUGH = "pass_through", _("По себестоимости")


class TariffRule(BaseModel):
    """Тарифное правило клиента `[ТЗ 3.4.1]` (`DOMAIN.md § 7.2`).

    Область действия — отдельные nullable-связи, а не JSONB (`BACKEND.md § 4`):
    по ним идёт выборка подходящих правил на каждую заявку, и выражение
    по полю JSONB там стоило бы на порядок дороже без всякой выгоды.

    Приоритет вычисляется, а не хранится: он выводится из заполненности
    области (`DOMAIN.md § 7.2`), и хранимое значение разъезжалось бы
    с областью при первой же правке.
    """

    id_prefix: ClassVar[str] = "trf"

    client = models.ForeignKey(
        "counterparties.Client", on_delete=models.CASCADE, related_name="tariff_rules"
    )

    service = models.ForeignKey(
        "catalog.Service",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="tariff_rules",
        help_text=_("Правило на конкретную услугу: приоритет 3"),
    )
    category = models.CharField(
        max_length=16, blank=True, help_text=_("Правило на категорию: приоритет 2")
    )
    airport_icao = models.CharField(
        max_length=4, blank=True, help_text=_("Модификатор: +1 к приоритету")
    )

    mode = models.CharField(max_length=16, choices=TariffMode.choices)
    markup_percent = models.DecimalField(
        max_digits=6, decimal_places=4, null=True, blank=True
    )
    fixed_amount = models.DecimalField(max_digits=18, decimal_places=4, null=True, blank=True)
    fixed_currency = models.CharField(max_length=3, blank=True)

    discount_kind = models.CharField(
        max_length=8,
        blank=True,
        choices=[("percent", _("Процент")), ("fixed", _("Фиксированная"))],
    )
    discount_value = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True
    )

    valid_from = models.DateTimeField()
    valid_to = models.DateTimeField(db_index=True)

    class Meta:
        verbose_name = _("Тарифное правило")
        verbose_name_plural = _("Тарифные правила")
        ordering = ("client", "-valid_from")
        indexes = (
            models.Index(fields=("client", "valid_from", "valid_to")),
            models.Index(fields=("client", "service")),
        )
        constraints = (
            models.CheckConstraint(
                condition=models.Q(valid_to__gt=models.F("valid_from")),
                name="tariff_valid_to_after_valid_from",
                violation_error_message=_("Дата окончания правила раньше даты начала"),
            ),
        )

    def __str__(self) -> str:
        return f"{self.client_id}: {self.get_mode_display()}"

    @property
    def priority(self) -> int:
        """Чем специфичнее область, тем выше приоритет (`DOMAIN.md § 7.2`)."""
        base = 3 if self.service_id else (2 if self.category else 1)
        return base + (1 if self.airport_icao else 0)


class DocumentCounter(models.Model):
    """Счётчик номеров документов (`BACKEND.md § 3.5`).

    Номер выдаётся `select_for_update()` внутри транзакции документа —
    это даёт сквозную нумерацию без дыр при параллельной работе.
    Последовательность Postgres здесь не подошла бы: она пропускает
    значения при откате транзакции, а дыра в нумерации счетов — это
    вопрос от налоговой.

    Модель не наследует `BaseModel`: у счётчика нет ни происхождения
    данных, ни демонстрационного признака — это служебная запись.
    """

    doc_type = models.CharField(max_length=16)
    year = models.PositiveSmallIntegerField()
    last_number = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = _("Счётчик номеров документов")
        verbose_name_plural = _("Счётчики номеров документов")
        constraints = (
            models.UniqueConstraint(
                fields=("doc_type", "year"), name="unique_document_counter"
            ),
        )

    def __str__(self) -> str:
        return f"{self.doc_type} {self.year}: {self.last_number}"


class QuoteStatus(models.TextChoices):
    DRAFT = "draft", _("Черновик")
    ISSUED = "issued", _("Выставлена")
    ACCEPTED = "accepted", _("Принята")
    DECLINED = "declined", _("Отклонена")
    EXPIRED = "expired", _("Истекла")
    VOIDED = "voided", _("Аннулирована")


class InvoiceStatus(models.TextChoices):
    DRAFT = "draft", _("Черновик")
    ISSUED = "issued", _("Выставлен")
    SENT = "sent", _("Отправлен")
    PARTIALLY_PAID = "partially_paid", _("Оплачен частично")
    PAID = "paid", _("Оплачен")
    OVERDUE = "overdue", _("Просрочен")
    VOIDED = "voided", _("Аннулирован")


class BillingDocument(BaseModel):
    """Общее для котировки и счёта.

    Абстрактная модель, а не одна таблица с признаком типа: у документов
    разные статусы, разные сроки и разные правила формирования строк —
    объединение потребовало бы половину полей держать пустыми.
    """

    number = models.CharField(max_length=64, blank=True, db_index=True)
    flight = models.ForeignKey(
        "flights.Flight", on_delete=models.PROTECT, related_name="%(class)ss"
    )
    client = models.ForeignKey(
        "counterparties.Client", on_delete=models.PROTECT, related_name="%(class)ss"
    )
    currency = models.CharField(max_length=3)

    issued_at = models.DateTimeField(null=True, blank=True)
    # Курс фиксируется на дату документа и хранится в самом документе
    # (`SPEC.md § 7.2`): пересчёт по сегодняшнему курсу менял бы сумму
    # уже выставленного документа.
    fx_snapshot = models.JSONField(default=dict, blank=True)

    subtotal_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    discount_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    fees_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    vat_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    total_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)

    fees = models.JSONField(default=list, blank=True)

    class Meta:
        abstract = True


class Quote(BillingDocument):
    """Котировка `[ТЗ 3.4.1]`: планируемые услуги рейса до вылета."""

    id_prefix: ClassVar[str] = "qte"

    status = models.CharField(
        max_length=16, choices=QuoteStatus.choices, default=QuoteStatus.DRAFT, db_index=True
    )
    valid_until = models.DateTimeField(null=True, blank=True)
    voided_by = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="voids"
    )

    class Meta:
        verbose_name = _("Котировка")
        verbose_name_plural = _("Котировки")
        ordering = ("-created_at",)
        constraints = (
            # Неизменяемость на уровне базы (`BACKEND.md § 3.4`): у документа
            # со статусом дальше черновика обязаны быть номер и дата
            # выставления. Обойти это через админку или psql не получится.
            models.CheckConstraint(
                condition=models.Q(status="draft")
                | (~models.Q(number="") & models.Q(issued_at__isnull=False)),
                name="quote_issued_has_number_and_date",
                violation_error_message=_(
                    "У выставленной котировки обязаны быть номер и дата выставления"
                ),
            ),
            models.UniqueConstraint(
                fields=("number",),
                condition=~models.Q(number=""),
                name="quote_number_unique",
            ),
        )

    def __str__(self) -> str:
        return self.number or f"Котировка (черновик) {self.pk}"


class Invoice(BillingDocument):
    """Счёт клиенту `[ТЗ 3.4.1]`: фактически оказанные услуги."""

    id_prefix: ClassVar[str] = "inv"

    status = models.CharField(
        max_length=16, choices=InvoiceStatus.choices, default=InvoiceStatus.DRAFT, db_index=True
    )
    quote = models.ForeignKey(
        Quote, on_delete=models.SET_NULL, null=True, blank=True, related_name="invoices"
    )
    # issued_at + paymentTerms.deferDays клиента
    due_date = models.DateTimeField(null=True, blank=True, db_index=True)
    # Сопоставление «план ↔ факт» (`SPEC.md § 7.2`): за счёт чего счёт
    # отличается от котировки. Считается при формировании и хранится:
    # котировка может быть аннулирована, а объяснение обязано остаться.
    plan_fact_comparison = models.JSONField(default=list, blank=True)
    voided_by = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="voids"
    )

    class Meta:
        verbose_name = _("Счёт клиенту")
        verbose_name_plural = _("Счета клиентам")
        ordering = ("-created_at",)
        indexes = (models.Index(fields=("client", "status", "due_date")),)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(status="draft")
                | (~models.Q(number="") & models.Q(issued_at__isnull=False)),
                name="invoice_issued_has_number_and_date",
                violation_error_message=_(
                    "У выставленного счёта обязаны быть номер и дата выставления"
                ),
            ),
            models.UniqueConstraint(
                fields=("number",),
                condition=~models.Q(number=""),
                name="invoice_number_unique",
            ),
        )

    def __str__(self) -> str:
        return self.number or f"Счёт (черновик) {self.pk}"


class DocumentLine(BaseModel):
    """Строка котировки или счёта (`DOMAIN.md § 6` DocumentLine).

    Отдельная таблица, а не JSONB (`BACKEND.md § 4`): по строкам идёт
    сверка с заявками и разбор расхождений, и вытаскивать их из JSONB
    на каждом счёте было бы неудобно и дорого.

    Ровно один владелец: строка принадлежит либо котировке, либо счёту.
    """

    id_prefix: ClassVar[str] = "dln"

    quote = models.ForeignKey(
        Quote, on_delete=models.CASCADE, null=True, blank=True, related_name="lines"
    )
    invoice = models.ForeignKey(
        Invoice, on_delete=models.CASCADE, null=True, blank=True, related_name="lines"
    )

    service_order = models.ForeignKey(
        "orders.ServiceOrder",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="document_lines",
    )
    description = models.CharField(max_length=500)
    airport_icao = models.CharField(max_length=4)

    quantity = models.DecimalField(max_digits=18, decimal_places=4)
    unit_price_amount = models.DecimalField(max_digits=18, decimal_places=4)
    amount = models.DecimalField(max_digits=18, decimal_places=4)
    currency = models.CharField(max_length=3)

    vat_rate = models.ForeignKey(
        "catalog.VatRate",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="document_lines",
    )
    vat_amount = models.DecimalField(max_digits=18, decimal_places=4, default=0)

    # Какое тарифное правило дало эту цену — для объяснимости `[ТЗ 3.4.1]`.
    # Ссылкой, а не снимком: правило не удаляется, а объяснение нужно
    # уметь развернуть в подробности.
    tariff_rule = models.ForeignKey(
        TariffRule, on_delete=models.SET_NULL, null=True, blank=True, related_name="lines"
    )

    class Meta:
        verbose_name = _("Строка документа")
        verbose_name_plural = _("Строки документов")
        ordering = ("created_at",)
        constraints = (
            models.CheckConstraint(
                condition=(
                    models.Q(quote__isnull=False, invoice__isnull=True)
                    | models.Q(quote__isnull=True, invoice__isnull=False)
                ),
                name="document_line_has_exactly_one_owner",
                violation_error_message=_(
                    "Строка принадлежит либо котировке, либо счёту, но не обоим"
                ),
            ),
        )

    def __str__(self) -> str:
        return f"{self.description}: {self.amount} {self.currency}"


class PayableStatus(models.TextChoices):
    """Состояния заявки на оплату `[ТЗ 3.4.2]` (`DOMAIN.md § 6`)."""

    PENDING = "pending", _("Ожидает согласования")
    APPROVED = "approved", _("Согласована")
    SCHEDULED = "scheduled", _("В плане платежей")
    PAID = "paid", _("Оплачена")
    DISPUTED = "disputed", _("Спорная")
    CANCELLED = "cancelled", _("Отменена")


class Payable(BaseModel):
    """Заявка на оплату поставщику `[ТЗ 3.4.2]` (`SPEC.md § 7.3`).

    Заводится автоматически при переходе услуги в «Выполнена»
    (`DOMAIN.md § 5.2`): к этому моменту известны и факт оказания,
    и фактическая стоимость.

    Срок оплаты считается от **снимка** условий контракта, а не от карточки
    поставщика: контракт мог смениться, а обязательство возникло на прежних
    условиях (ADR-025, `CLAUDE.md § 3` п. 5).
    """

    id_prefix: ClassVar[str] = "pay"

    number = models.CharField(max_length=64, blank=True, db_index=True)
    vendor = models.ForeignKey(
        "counterparties.Vendor", on_delete=models.PROTECT, related_name="payables"
    )
    # Заявок на оплату может покрывать несколько услуг: группировка
    # настраивается (`SPEC.md § 7.3`). Связь «многие ко многим», а не одна
    # заявка на услугу, именно поэтому.
    service_orders = models.ManyToManyField(
        "orders.ServiceOrder", related_name="payables", blank=True
    )

    amount = models.DecimalField(max_digits=18, decimal_places=4)
    currency = models.CharField(max_length=3)
    due_date = models.DateTimeField(db_index=True)

    status = models.CharField(
        max_length=16, choices=PayableStatus.choices, default=PayableStatus.PENDING,
        db_index=True,
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="approved_payables",
    )

    vendor_invoice = models.ForeignKey(
        "billing.VendorInvoice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payables",
    )

    class Meta:
        verbose_name = _("Заявка на оплату")
        verbose_name_plural = _("Заявки на оплату")
        ordering = ("due_date", "-created_at")
        constraints = (
            models.CheckConstraint(
                condition=models.Q(amount__gte=0),
                name="payable_amount_not_negative",
                violation_error_message=_("Сумма заявки на оплату не может быть отрицательной"),
            ),
            # Дата согласования обязательна там, где согласование
            # состоялось. Спорная и отменённая заявка согласование
            # не проходили: сверка находит расхождение **до** оплаты,
            # и требовать от неё даты согласования значило бы запретить
            # спорить, пока не согласуешь.
            models.CheckConstraint(
                condition=(
                    ~models.Q(status__in=["approved", "scheduled", "paid"])
                    | models.Q(approved_at__isnull=False)
                ),
                name="payable_approved_has_date",
                violation_error_message=_(
                    "Согласованная заявка обязана нести дату согласования"
                ),
            ),
        )

    def __str__(self) -> str:
        return f"{self.number or self.pk}: {self.amount} {self.currency}"

    def is_overdue(self, at: Any = None) -> bool:
        """Просрочена ли оплата.

        Оплаченная и отменённая не просрочены никогда: срок к ним
        уже не относится.
        """
        from core.clock import now

        if self.status in (PayableStatus.PAID, PayableStatus.CANCELLED):
            return False
        return (at or now()) > self.due_date


class VendorInvoice(BaseModel):
    """Счёт поставщика для сверки `[ТЗ 3.4.2]` (`DOMAIN.md § 6`).

    Строки счёта хранятся отдельной моделью, а результат сверки — снимком
    в JSON: он посчитан на момент импорта по тогдашним заявкам, и
    пересчитывать его при показе значило бы показывать другую сверку,
    чем ту, по которой принимали решения.
    """

    id_prefix: ClassVar[str] = "vin"

    vendor = models.ForeignKey(
        "counterparties.Vendor", on_delete=models.PROTECT, related_name="invoices"
    )
    number = models.CharField(max_length=64)
    issued_at = models.DateTimeField()
    currency = models.CharField(max_length=3)

    # Форма `ReconciliationResult` из контракта.
    reconciliation = models.JSONField(default=dict, blank=True)
    # Коды поставщика, которым не нашлось соответствия (ADR-024).
    unmapped_codes = models.JSONField(default=list, blank=True)

    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Счёт поставщика")
        verbose_name_plural = _("Счета поставщиков")
        ordering = ("-issued_at", "-created_at")
        constraints = (
            models.UniqueConstraint(
                fields=("vendor", "number"), name="unique_vendor_invoice_number"
            ),
        )

    def __str__(self) -> str:
        return f"{self.vendor_id} {self.number}"


class VendorInvoiceLine(BaseModel):
    """Строка счёта поставщика.

    `service_code` — код в **его** номенклатуре, как он прислал. Наш
    `service` проставляется сопоставлением (ADR-024) и может остаться
    пустым: неопознанный код — повод завести соответствие, а не повод
    отказать в импорте счёта.
    """

    id_prefix: ClassVar[str] = "vil"

    invoice = models.ForeignKey(
        VendorInvoice, on_delete=models.CASCADE, related_name="lines"
    )
    position = models.PositiveSmallIntegerField(
        help_text=_("Номер строки в счёте: на него ссылается расхождение")
    )

    airport_icao = models.CharField(max_length=4)
    service_date = models.DateTimeField()
    service_code = models.CharField(max_length=64)
    service = models.ForeignKey(
        "catalog.Service",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="vendor_invoice_lines",
    )

    quantity = models.DecimalField(max_digits=18, decimal_places=4)
    unit_price = models.DecimalField(max_digits=18, decimal_places=4)
    amount = models.DecimalField(max_digits=18, decimal_places=4)

    class Meta:
        verbose_name = _("Строка счёта поставщика")
        verbose_name_plural = _("Строки счетов поставщиков")
        ordering = ("invoice", "position")
        constraints = (
            models.UniqueConstraint(
                fields=("invoice", "position"), name="unique_vendor_invoice_line_position"
            ),
        )

    def __str__(self) -> str:
        return f"{self.position}. {self.service_code} {self.amount}"
