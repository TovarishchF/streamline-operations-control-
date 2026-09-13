"""Финансовые сущности. На этой вехе — только курсы валют `[ТЗ 3.4.1]`.

Тарифы, котировки, счета, заявки на оплату и сверка — M7 (`TASKS.md`).
Курс появляется раньше, потому что от него зависит расчёт маржи рейса,
а рейсы — уже M4.

`INTEGRATIONS § 2.1`: курс запрашивается фоновой задачей раз в сутки
и **сохраняется в базу**. Документы ссылаются на сохранённую запись,
а не на провайдера: при недоступности источника система работает
на последнем известном курсе и выводит предупреждение.
"""

from __future__ import annotations

from typing import ClassVar

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
