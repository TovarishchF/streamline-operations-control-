"""Набор данных генератора `[ТЗ этап 2]` (`SPEC.md § 11`).

`make seed-sample`. Доступна только при `SAMPLE_DATA=true` (ADR-008): при
выключенном генераторе команда отказывается работать, чтобы придуманные
контрагенты не оказались в рабочей базе.

Правила честности (`CLAUDE.md § 4`) соблюдаются буквально:

* наименования клиентов и поставщиков вымышлены, совпадения случайны;
* реальны только общедоступные справочные данные — коды аэропортов,
  обозначения типов воздушных судов, коды валют; они приходят
  из `seed_reference` и здесь не выдумываются; курсов валют генератор
  тоже не выдумывает — документы считаются по курсам ЦБ РФ из базы;
* каждая запись несёт `is_generated=True` и `data_source='synthetic'`,
  поэтому её можно удалить одной командой, не задев введённое людьми;
  пользователи генератора узнаются по адресу в зоне `soc.local`;
* записи аудита от генератора имеют `source='seed'` и автора
  «Система (генератор данных)» — они не выдаются за действия людей;
* набор генерируется относительно текущей даты, а не «историей за год».

История набора проводится через те же сервисы, что и работа человека:
заказ услуги со снимком цены, подтверждение поставщиком, акт, счёт,
платёж, сверка. Часы на время каждого события останавливаются на его
моменте (`core.clock.frozen`), а признаки генератора ставит
`core.sample_data.generating`. Поэтому суммы, сроки SLA, номера документов
и статусы в наборе посчитаны системой, а не вписаны генератором.

Генератор детерминирован: один и тот же `--seed` даёт один и тот же набор.
Это нужно, чтобы снимки экранов и разговор с заказчиком воспроизводились.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from html import escape
from pathlib import Path
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.core.management.base import BaseCommand
from django.db import transaction

from accounts import services as accounts
from accounts.models import Organization, Role, TimezoneMode, User
from audit import services as audit
from audit.models import AuditEntityType, AuditEntry, AuditSource
from billing.models import (
    DocumentLine,
    Invoice,
    Payable,
    PayableStatus,
    Payment,
    PaymentSource,
    Quote,
    TariffMode,
    TariffRule,
    VendorInvoice,
)
from billing.services import documents, reconciliation
from billing.services import payables as payable_services
from billing.services import payments as payment_services
from billing.services import tariffs as tariff_services
from catalog import services as catalog_services
from catalog.models import AircraftType, Airport, Service, ServiceCategory, VendorPrice
from comms.models import InboxMessage, Notification, OutboxMessage
from core import clock, sample_data
from core.exceptions import DomainError, SampleDataDisabled
from core.models import Attachment, AttachmentKind, DataSource, make_id
from core.money import Money
from core.services import storage
from counterparties import services as counterparty_services
from counterparties.models import Client, Contact, PaymentMode, Vendor, VendorContract
from fleet.models import Aircraft, AircraftApproval, AircraftStatus
from flights.models import (
    Flight,
    FlightRequest,
    FlightTemplate,
    ServiceLeg,
    Slot,
    SlotStatus,
    SlotType,
)
from flights.services import planning, transitions
from orders.models import ServiceOrder, ServiceOrderStatus, SlaPenaltyKind, SlaRule
from orders.services import orders as order_services
from orders.services import sla as sla_services
from orders.services import transitions as order_transitions

if TYPE_CHECKING:
    from argparse import ArgumentParser

# Вымышленные наименования. Совпадения с существующими организациями
# случайны и нежелательны: при таком совпадении наименование нужно заменить.
CLIENT_NAMES = (
    "Авиалинии Северного Ветра",
    "Полярная Авиакомпания",
    "Каспий Эйр",
    "Верхневолжские Авиалинии",
    "Сибирский Меридиан",
    "Уральский Экспресс",
    "Байкал Бизнес Джет",
    "Аврора Флай",
    "Терра Авиа",
    "Гранит Эйрлайнс",
    "Новый Горизонт",
    "Магистраль Карго",
)

# Вымышленные контактные лица контрагентов.
CONTACT_NAMES = (
    ("Иван", "Петров"),
    ("Мария", "Орлова"),
    ("Сергей", "Кузнецов"),
    ("Анна", "Белова"),
    ("Дмитрий", "Ершов"),
    ("Ольга", "Сомова"),
)

CONTACT_ROLES = ("Диспетчер", "Менеджер по работе с клиентами", "Руководитель смены")

# Доля контрагентов, переписывающихся по-английски.
ENGLISH_CONTACT_SHARE = 0.25

# Сколько заявок, ожидающих ответа поставщика, получают письмо в исходящих:
# на них показывается разбор входящих.
PENDING_ORDERS = 12

# Доли состояний исходящих: экран должен показывать не только «отправлено».
FAILED_MESSAGE_SHARE = 0.1
SENT_MESSAGE_SHARE = 0.7

# Сколько событий положить в колокольчик.
GENERATED_NOTIFICATIONS = 6

# Доля слотов будущих рейсов, ожидающих ответа координатора.
PENDING_SLOT_SHARE = 0.3

# Регулярные направления набора: наименование, вылет, прилёт, местный час
# вылета, дни недели по ISO.
GENERATED_TEMPLATES = (
    ("Москва — Петербург, будни", "UUWW", "ULLI", 9, (1, 2, 3, 4, 5)),
    ("Москва — Сочи, выходные", "UUDD", "URSS", 11, (6, 7)),
    ("Петербург — Москва, вечерний", "ULLI", "UUWW", 19, (1, 3, 5)),
)

VENDOR_NAMES: dict[str, tuple[str, ...]] = {
    "fuel": ("Топливная Компания Восток", "Аэро Фьюэл Сервис", "Нефтепродукт Аэро", "Крыло-Ойл"),
    "handling": ("Хэндлинг Групп", "Аэросервис Столица", "Терминал Плюс", "Грин Гейт"),
    "catering": ("Небесный Стол", "Кейтеринг Аврора", "Гурмэ Флай"),
    "transport": ("Трансфер Премиум", "Автопарк Аэро", "Логистик Драйв"),
    "permits": ("Пермит Бюро", "Аэронавигация Консалт"),
    "deicing": ("Антилёд Сервис", "Дайсинг Технологии"),
}

# Зарубежные станции обслуживают местные компании в местной валюте.
# Наименования вымышлены; страна и валюта — настоящие коды ISO.
FOREIGN_VENDORS = (
    ("Alpenrand Ground Services", "CH", "EUR", ("LSGG", "LFPB")),
    ("Seine Ramp Partners", "FR", "EUR", ("LFPB", "EGGW")),
    ("Chiltern Jet Support", "GB", "EUR", ("EGGW", "LSGG")),
    ("Dune Line Aviation Support", "AE", "USD", ("OMDB", "LTFM")),
    ("Bosporus Ramp Services", "TR", "USD", ("LTFM", "OMDB")),
    ("Tien Shan Ground", "KZ", "USD", ("UACC", "UBBB")),
    ("Absheron Ramp Services", "AZ", "USD", ("UBBB", "UDYZ")),
    ("Sevan Ramp Services", "AM", "USD", ("UDYZ", "UACC")),
)
FOREIGN_SPECIALIZATIONS = ("fuel", "handling", "catering", "transport")

# Пользователи генератора: логин — фамилия латиницей, адрес — в зоне
# `soc.local`. По зоне их находит очистка: у пользователя нет признака
# `is_generated`, а логин без суффикса ничем не отличается от настоящего.
GENERATED_EMAIL_DOMAIN = "soc.local"

# Общий пароль пользователей генератора. Заведомо известен: набор нужен,
# чтобы систему смотрели и пробовали, а не чтобы его охраняли.
GENERATED_PASSWORD = "soc-vhod-2026-parol"  # noqa: S105 — общий пароль набора, не секрет

# Вымышленные сотрудники. Роль «Продажи» не заводится: она ожидает
# подтверждения заказчиком (ADR-011, G-06).
STAFF = (
    ("Волкова Анна Сергеевна", Role.ADMIN, "Europe/Moscow"),
    ("Карпов Илья Дмитриевич", Role.DISPATCHER, "Europe/Moscow"),
    ("Нестеров Павел Юрьевич", Role.DISPATCHER, "Asia/Yekaterinburg"),
    ("Ильина Марина Олеговна", Role.DISPATCHER, "Europe/Moscow"),
    ("Гордеева Ольга Ивановна", Role.FINANCE, "Europe/Moscow"),
    ("Соколов Артём Викторович", Role.MANAGER, "Europe/Moscow"),
)

# Бортовые номера вымышлены. Регистрационные префиксы настоящие: они
# определяют государство регистрации и влияют на разрешительные документы.
REGISTRATION_PREFIXES = ("RA-", "M-", "9H-", "T7-", "VP-B")

# Доли и пороги генератора вынесены в константы: иначе числа в коде
# читаются как случайные, а они задают вид набора.
SECOND_SPECIALIZATION_SHARE = 0.3
EXPIRING_APPROVAL_SHARE = 0.4
AIRCRAFT_COUNT = 26
CARGO_EVERY = 6

# Рейсы генерируются относительно текущей даты (CLAUDE.md § 4), а не
# «историей за год»: система должна выглядеть работающей сегодня.
FLIGHTS_BACK_DAYS = 30
FLIGHTS_FORWARD_DAYS = 14
FLIGHTS_PER_DAY = 4
CANCELLED_SHARE = 0.08

# Дальние рейсы частью ещё только запланированы: заявок по ним нет.
UNPLANNED_FROM_DAY = 7
UNPLANNED_SHARE = 0.35

# Ответы поставщиков. Доли малы намеренно: отказ и опоздание — повод
# для разбора, а не обычное течение дел.
REJECT_SHARE = 0.025
SLA_LATE_SHARE = 0.03
# С какого дня вперёд часть заявок ещё ждёт ответа поставщика.
PENDING_ANSWERS_FROM_DAY = 2
PENDING_ANSWER_SHARE = 0.25

REJECTION_REASONS = (
    "Нет свободного топливозаправщика на это время",
    "Бригада занята на другом рейсе, перенос невозможен",
    "Не успеваем к указанному времени",
)
URGENT_REASON = "Срочный рейс: заявка клиента поступила позже нормативного срока"
REASSIGN_COMMENT = "Поставщик отказал, услуга заказана у другого"

# За сколько часов до вылета рейс готов к вылету.
READY_BEFORE_HOURS = 3
# Задержки вылета, минуты: большинство рейсов уходит вовремя.
DELAYS = (0, 0, 0, 5, 10, 15, 25, 40)

# Маршрут собирается из пары аэропортов: меньше двух — собирать не из чего.
MIN_ROUTE_AIRPORTS = 2

# Номера бортов, которым задаётся особое состояние. Набор без единого
# неисправного борта не даёт показать ни одного сценария срыва расписания.
AOG_INDEX = 3
MAINTENANCE_INDEXES = (7, 14)

# Предпочитаемые базы приписки. Берутся из справочника, а не подставляются
# как есть: код аэропорта, которого нет в справочнике, — выдуманные данные,
# а выдумывать справочные сведения нельзя (`CLAUDE.md § 4`).
HOME_BASES = ("UUWW", "UUDD", "UUEE", "ULLI", "USSS", "UNNT", "UWWW", "URSS")

# Направления расписания генератора: настоящие аэропорты, среди них
# международные — иначе не показать проверку разрешительных документов.
DOMESTIC_ROUTES_ICAO = (
    "UUWW", "UUDD", "UUEE", "ULLI", "USSS", "UNNT", "UWWW", "URSS", "UWKD", "UHWW",
)
FOREIGN_CURRENCY = {
    "LFPB": "EUR", "LSGG": "EUR", "EGGW": "EUR",
    "OMDB": "USD", "LTFM": "USD", "UACC": "USD", "UBBB": "USD", "UDYZ": "USD",
}
GENERATED_ROUTES_ICAO = (*DOMESTIC_ROUTES_ICAO, *FOREIGN_CURRENCY)

# Российские станции: поставщик категории обслуживает от двух до трёх
# аэропортов из каждой пятёрки — у каждой услуги есть из кого выбирать.
VENDORS_PER_STATION = 2

# Закупочные цены, ₽ за единицу услуги. Порядок величин правдоподобен
# для деловой авиации; это цены вымышленных поставщиков, а не рынка.
BASE_PRICES_RUB: dict[str, Decimal] = {
    "FUEL_JETA1": Decimal(78),
    "FUEL_AVGAS": Decimal(145),
    "FUEL_DEFUEL": Decimal(12),
    "HND_BASIC": Decimal(45000),
    "HND_CLEAN": Decimal(9000),
    "HND_GPU": Decimal(6500),
    "HND_HANGAR": Decimal(9000),
    "HND_LAV": Decimal(6000),
    "HND_PARK": Decimal(1800),
    "HND_TOW": Decimal(12000),
    "HND_VIP": Decimal(60000),
    "CAT_BAR": Decimal(18000),
    "CAT_CREW": Decimal(2500),
    "CAT_MEAL": Decimal(6500),
    "TRN_CARGO": Decimal(35),
    "TRN_CREW": Decimal(4500),
    "TRN_HOTEL": Decimal(9000),
    "TRN_VIP": Decimal(14000),
    "PRM_CUSTOMS": Decimal(18000),
    "PRM_LANDING": Decimal(30000),
    "PRM_OVERFLY": Decimal(25000),
    "PRM_SLOT": Decimal(8000),
    "DEI_TYPE1": Decimal(320),
    "DEI_TYPE4": Decimal(520),
}
# Сколько рублей в единице цены зарубежной станции. Не курс валюты,
# а уровень цен: за рубежом услуги дороже, чем дал бы пересчёт по курсу.
FOREIGN_PRICE_DIVISOR = {"EUR": Decimal(75), "USD": Decimal(70)}
MOSCOW_AIRPORTS = ("UUWW", "UUDD", "UUEE")
# Доля поставщиков, у которых в справочнике есть прошлый прайс.
PRICE_HISTORY_SHARE = 0.4
PRICE_INCREASE = Decimal("1.07")

# Договоры. Индексы поставщиков в порядке создания: истекающие в ближайший
# месяц и истёкшие без продления — «светофор» на экране договоров.
EXPIRING_CONTRACTS = {2: 6, 7: 13, 11: 21, 15: 27}
EXPIRED_CONTRACTS = {5: 12, 17: 45}
RENEWED_CONTRACTS = (0, 9, 20)

# Клиент с фиксированной ценой топлива, закреплённой договором до роста
# цен: на его рейсах маржа отрицательная, и система должна это показать.
NEGATIVE_MARGIN_CLIENT = "Гранит Эйрлайнс"
NEGATIVE_MARGIN_FUEL_PRICE = Decimal("61.50")
PASS_THROUGH_FUEL_CLIENTS = ("Каспий Эйр", "Уральский Экспресс")
FIXED_HANDLING_CLIENT = "Авиалинии Северного Ветра"
FIXED_HANDLING_PRICE = Decimal(52000)
DISCOUNT_CLIENT = "Верхневолжские Авиалинии"
AIRPORT_RULE_CLIENT = "Полярная Авиакомпания"

# Сроки SLA по категориям, минуты: подтверждение и исполнение.
SLA_RULES = (
    (ServiceCategory.FUEL, 60, 120),
    (ServiceCategory.HANDLING, 120, 180),
    (ServiceCategory.CATERING, 180, None),
    (ServiceCategory.TRANSPORT, 120, None),
    (ServiceCategory.PERMITS, 720, None),
    (ServiceCategory.DEICING, 30, 60),
)

# Платежи клиентов: доли полностью и частично оплаченных счетов.
PAID_SHARE = 0.62
PARTIAL_SHARE = 0.12
# Доля заявок на оплату, которые финансист не успел согласовать к сроку.
OVERDUE_PAYABLE_SHARE = 0.2

# Счета поставщиков: всего и сколько из них с расхождениями (`SPEC.md § 11`).
VENDOR_INVOICES = 12
VENDOR_INVOICES_WITH_DISCREPANCIES = 5
# Код, которого нет в справочнике соответствий: попадает в очередь
# сопоставления номенклатуры.
UNMAPPED_VENDOR_CODE = "GH-RAMP-STD"
# Меньше трёх строк — не из чего собрать счёт с расхождениями.
MIN_INVOICE_LINES = 3
FUEL_EXCESS_L = 100

# Что заказывают на рейс помимо топлива и обслуживания: доля рейсов.
PLAN_SHARES = {
    "CAT_MEAL": 0.7,
    "TRN_VIP": 0.5,
    "CAT_CREW": 0.4,
    "HND_GPU": 0.3,
    "TRN_HOTEL": 0.25,
    "DEI_TYPE1": 0.2,
}
# Плановое топливо, литры: нижняя граница и заказ, если план не посчитан.
MIN_FUEL_L = 1500
DEFAULT_FUEL_L = 4000
# Доля топливных поставщиков со сбором за заправку «в крыло».
INTO_PLANE_SHARE = 0.5
# Цена от тысячи — в целых единицах, дешевле — с копейками.
WHOLE_UNITS_FROM = Decimal(1000)

ACT_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 18mm; }}
body {{ font-family: sans-serif; font-size: 10.5pt; color: #111; }}
h1 {{ font-size: 14pt; text-align: center; margin-bottom: 4mm; }}
table {{ width: 100%; border-collapse: collapse; margin: 4mm 0; }}
th, td {{ border: 1px solid #666; padding: 4px 6px; text-align: left; }}
.sign td {{ border: none; padding-top: 22mm; }}
</style></head><body>
<h1>Акт № {number}<br>выполненных работ (оказанных услуг)</h1>
<p>Дата: {date}</p>
<p>Исполнитель: {vendor}<br>Заказчик: {customer}</p>
<p>Рейс {flight}, аэропорт {airport}, воздушное судно {registration}</p>
<table>
<tr><th>Услуга</th><th>Ед.</th><th>Количество</th><th>Начало, UTC</th><th>Окончание, UTC</th></tr>
<tr><td>{service}</td><td>{unit}</td><td>{quantity}</td><td>{start}</td><td>{end}</td></tr>
</table>
<p>Услуги оказаны полностью и в срок. Стороны претензий друг к другу не имеют.</p>
<table class="sign"><tr><td>Исполнитель ____________________</td>
<td>Заказчик ____________________</td></tr></table>
</body></html>"""


class ReferenceDataMissing(DomainError):
    """Набор генератора опирается на справочники, а их нет.

    Молчаливый выход отсюда выглядел бы как успешная генерация пустого
    набора: команда отработала, а в системе ничего не появилось.
    """

    code = "VALIDATION_ERROR"


@dataclass(frozen=True, slots=True)
class Crew:
    """Сотрудники, от имени которых сервисы ведут историю набора.

    Сервисы требуют пользователя, но в журнале действие всё равно
    записывается генератором (`core.sample_data.generating`).
    """

    dispatcher: User
    finance: User


class Command(BaseCommand):
    help = "Набор данных генератора (только при SAMPLE_DATA=true)"

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--seed", type=int, default=20260913, help="Зерно генератора")
        parser.add_argument("--purge", action="store_true", help="Удалить записи генератора")

    def handle(self, *args: Any, **options: Any) -> None:
        if not sample_data.enabled():
            raise SampleDataDisabled(
                "Команда доступна только при SAMPLE_DATA=true: в рабочей базе "
                "придуманные контрагенты недопустимы (ADR-008)"
            )

        counts = (
            self.purge() if options["purge"] else self.generate(int(options["seed"]))
        )
        for name, count in counts.items():
            self.stdout.write(f"{name}: {count}")
        if options["purge"]:
            self.stdout.write(
                "Записи журнала не удаляются: таблица аудита только пополняется "
                "(BACKEND.md § 3.9)."
            )

    # ─────────────────────────── очистка ───────────────────────────

    @transaction.atomic
    def purge(self) -> dict[str, int]:
        """Удаляет только записи генератора.

        Порядок обратен порядку создания: связи защищены `PROTECT`, поэтому
        сначала уходят пользователи порталов и документы, затем рейсы
        и борта и только потом контрагенты, на которых те ссылаются.
        """
        counts = {
            "пользователи": User.objects.filter(
                email__endswith=f"@{GENERATED_EMAIL_DOMAIN}"
            ).delete()[0],
            # Коммуникации уходят первыми: входящее ссылается на заявку,
            # уведомление — на пользователя.
            "уведомления": Notification.objects.filter(is_generated=True).delete()[0],
            "входящие": InboxMessage.objects.filter(is_generated=True).delete()[0],
            "исходящие": OutboxMessage.objects.filter(is_generated=True).delete()[0],
            "вложения": self._purge_attachments(),
            "контакты": Contact.objects.filter(is_generated=True).delete()[0],
            "заявки клиентов": FlightRequest.objects.filter(is_generated=True).delete()[0],
            # Шаблон держит клиента и тип ВС связями PROTECT, поэтому
            # уходит раньше них.
            "шаблоны рейсов": FlightTemplate.objects.filter(is_generated=True).delete()[0],
            # Документы по рейсам генератора — тоже записи генератора
            # (признак наследуется от рейса). Строка держит заявку на услугу
            # связью PROTECT, поэтому документы уходят раньше заявок.
            # Платёж держит счёт связью PROTECT через распределение.
            "платежи": Payment.objects.filter(is_generated=True).delete()[0],
            "строки документов": DocumentLine.objects.filter(is_generated=True).delete()[0],
            "счета клиентам": Invoice.objects.filter(is_generated=True).delete()[0],
            "котировки": Quote.objects.filter(is_generated=True).delete()[0],
            "заявки на оплату": Payable.objects.filter(is_generated=True).delete()[0],
            "счета поставщиков": VendorInvoice.objects.filter(is_generated=True).delete()[0],
            "заявки на услуги": ServiceOrder.objects.filter(is_generated=True).delete()[0],
            "слоты": Slot.objects.filter(is_generated=True).delete()[0],
            "рейсы": Flight.objects.filter(is_generated=True).delete()[0],
            "борта": Aircraft.objects.filter(is_generated=True).delete()[0],
            # Договор держат заявки, поставщика — договор и цена: порядок
            # «заявки → договоры и цены → поставщики» обязателен.
            "договоры": VendorContract.objects.filter(is_generated=True).delete()[0],
            "цены поставщиков": VendorPrice.objects.filter(is_generated=True).delete()[0],
            "тарифы клиентов": TariffRule.objects.filter(is_generated=True).delete()[0],
            "правила SLA": SlaRule.objects.filter(is_generated=True).delete()[0],
            "клиенты": Client.objects.filter(is_generated=True).delete()[0],
            "поставщики": Vendor.objects.filter(is_generated=True).delete()[0],
            # Журнал неизменяем на уровне базы, и это правильно: удалять
            # записи аудита нельзя даже генератору. Записи генератора
            # отличимы по source='seed' и живут до пересоздания базы.
            "записи журнала": AuditEntry.objects.filter(is_generated=True).count(),
        }
        return counts

    @staticmethod
    def _purge_attachments() -> int:
        """Акты генератора удаляются вместе с файлами в хранилище."""
        attachments = Attachment.objects.filter(is_generated=True)
        for key in attachments.values_list("storage_key", flat=True):
            storage.delete_object(key)
        return int(attachments.delete()[0])

    # ─────────────────────────── генерация ───────────────────────────

    @staticmethod
    def _rnd(seed: int, key: str) -> random.Random:
        """Отдельный поток случайных чисел на каждую запись.

        Общий поток делал бы набор зависимым от того, что уже есть в базе:
        существующая запись пропускает часть вызовов, последовательность
        сдвигается, и повторный запуск с тем же зерном давал бы другие
        бортовые номера. Ключ записи в зерне это исключает.
        """
        return random.Random(f"{seed}:{key}")  # noqa: S311

    @transaction.atomic
    def generate(self, seed: int) -> dict[str, int]:
        if not Airport.objects.exists():
            raise ReferenceDataMissing(
                "Справочники пусты. Сначала: make seed-reference — "
                "набор генератора опирается на настоящие коды аэропортов."
            )

        with sample_data.generating():
            organization = self._organization()
            staff = self._staff(organization)
            self._bind_two_factor(staff)
            crew = Crew(
                dispatcher=next(user for user in staff if user.role == Role.DISPATCHER),
                finance=next(user for user in staff if user.role == Role.FINANCE),
            )
            clients = self._clients(organization, seed)
            vendors = self._vendors(organization, seed)
            aircraft = self._aircraft(clients, seed)
            self._portal_users(organization, clients, vendors)
            self._contacts(clients, vendors, seed)
            contracts = self._contracts(vendors, seed)
            prices = self._prices(vendors, seed)
            tariffs = self._tariffs(clients, crew, seed)
            self._sla_rules()
            flights = self._flights(clients, aircraft, crew, seed)
            conflicts = self._conflicts(aircraft, clients, seed)
            payments = self._payments(crew, seed)
            self._approve_payables(crew, seed)
            vendor_invoices = self._vendor_invoices(crew, seed)
            # Сроки, прошедшие к сегодняшнему дню, отмечает та же проверка,
            # что работает по расписанию.
            sla_services.mark_overdue_confirmations()
            requests = self._flight_requests(organization, clients, seed)
            templates = self._templates(organization, clients, seed)
            messages = self._communications(staff, seed)

        return {
            "клиенты": len(clients),
            "поставщики": len(vendors),
            "договоры": contracts,
            "цены поставщиков": prices,
            "тарифные правила": tariffs,
            "борта": len(aircraft),
            "сотрудники": len(staff),
            "рейсы": len(flights) + conflicts,
            "заявки на услуги": ServiceOrder.objects.filter(is_generated=True).count(),
            "счета клиентам": Invoice.objects.filter(is_generated=True).count(),
            "платежи": payments,
            "заявки на оплату": Payable.objects.filter(is_generated=True).count(),
            "счета поставщиков": vendor_invoices,
            "заявки клиентов": len(requests),
            "шаблоны рейсов": templates,
            "сообщения и уведомления": messages,
        }

    # ─────────────────────────── контрагенты ───────────────────────────

    def _contacts(
        self, clients: list[Client], vendors: list[Vendor], seed: int
    ) -> None:
        """Контактные лица контрагентов.

        Без них переписка не с кем: письмо поставщику уходит контактному
        лицу, а не «в компанию». Адреса в зоне `.test` — она по RFC 2606
        никому не принадлежит и настоящей не станет.
        """
        owners: list[Client | Vendor] = [*clients, *vendors]
        for owner in owners:
            rnd = self._rnd(seed, f"contact:{owner.name}")
            if Contact.objects.filter(
                client=owner if isinstance(owner, Client) else None,
                vendor=owner if isinstance(owner, Vendor) else None,
            ).exists():
                continue
            first, last = rnd.choice(CONTACT_NAMES)
            Contact.objects.create(
                client=owner if isinstance(owner, Client) else None,
                vendor=owner if isinstance(owner, Vendor) else None,
                name=f"{first} {last}",
                role=rnd.choice(CONTACT_ROLES),
                email=f"ops@{_translit(owner.name)[:18].replace(' ', '-').lower()}.test",
                phone=f"+7 495 {rnd.randint(100, 999)}-{rnd.randint(10, 99)}-{rnd.randint(10, 99)}",
                # Часть контрагентов переписывается по-английски: язык письма
                # выбирается по контакту, и это надо показывать.
                locale="en" if rnd.random() < ENGLISH_CONTACT_SHARE else "ru",
                is_primary=True,
                is_generated=True,
                data_source=DataSource.SYNTHETIC,
            )

    def _templates(
        self, organization: Organization, clients: list[Client], seed: int
    ) -> int:
        """Шаблоны регулярных рейсов `[ТЗ 3.1.1]`.

        Регулярные направления — то, ради чего шаблон и заводят. Набор
        без шаблонов не показывает ни их, ни генерацию серии.

        Время вылета местное: перевод в UTC делается при генерации серии,
        на каждую дату отдельно.
        """
        from datetime import time

        types = list(AircraftType.objects.order_by("icao_type")[:3])
        if not types or not clients:
            return 0

        created = 0
        for index, (name, dep, arr, hour, weekdays) in enumerate(GENERATED_TEMPLATES):
            rnd = self._rnd(seed, f"template:{name}")
            template, is_new = FlightTemplate.objects.get_or_create(
                name=name,
                defaults={
                    "organization": organization,
                    "client": rnd.choice(clients),
                    "aircraft_type": types[index % len(types)],
                    "dep_icao": dep,
                    "arr_icao": arr,
                    "dep_time_local": time(hour, 0),
                    "weekdays": list(weekdays),
                    "is_generated": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )
            if is_new:
                _record(
                    AuditEntityType.FLIGHT, template.pk, "template_created", {"name": name}
                )
                created += 1
        return created

    def _communications(self, staff: list[User], seed: int) -> int:
        """Переписка и уведомления набора `[ТЗ 3.5.1, 3.5.2, 3.2.2]`.

        Заявки, ожидающие ответа поставщика, получаются сами собой: часть
        заказов на ближайшие дни поставщики ещё не подтвердили. Письма
        по ним показывают разбор входящих. Сообщения помечены
        `source='seed'` и за действия людей не выдаются.
        """
        from comms.services import inbox as inbox_service
        from comms.services import notifications as notification_service
        from comms.services import outbox as outbox_service

        rnd = self._rnd(seed, "communications")
        created = 0

        pending = list(
            ServiceOrder.objects.filter(
                status=ServiceOrderStatus.ORDERED, vendor__isnull=False, is_generated=True
            )
            .select_related("vendor", "service", "flight")
            .order_by("pk")[:PENDING_ORDERS]
        )

        for order in pending:
            message = outbox_service.enqueue(
                channel="email",
                to=[
                    {"name": contact.name, "address": contact.email, "locale": contact.locale}
                    for contact in (order.vendor.contacts.all() if order.vendor else [])
                ],
                subject=f"Заявка {order.pk}: {order.service.name_ru}",
                body=(
                    f"Здравствуйте!\n\nЗаказываем услугу: {order.service.name_ru}.\n"
                    f"Аэропорт: {order.airport_icao}.\n"
                    f"Рейс: {order.flight.number}.\n\n"
                    f"Просим подтвердить заявку {order.pk}."
                ),
                template_code="order_placed",
                related=("service_order", order.pk),
                is_generated=True,
            )
            # Часть писем уже ушла, часть ещё в очереди, одно — с ошибкой:
            # экран исходящих должен показывать все состояния.
            roll = rnd.random()
            if roll < FAILED_MESSAGE_SHARE:
                message.status = "failed"
                message.attempts = 4
                message.last_error = "ChannelError: сервер исходящей почты недоступен"
                message.save()
            elif roll < FAILED_MESSAGE_SHARE + SENT_MESSAGE_SHARE:
                outbox_service.send(message)
            created += 1

        # Входящие собираются тем же разбором, что и в работе: часть писем
        # опознаётся, часть уходит в ручную очередь.
        created += inbox_service.poll(len(pending))

        dispatchers = [user for user in staff if user.role in (Role.DISPATCHER, Role.MANAGER)]
        for order in ServiceOrder.objects.filter(
            status=ServiceOrderStatus.COMPLETED, is_generated=True
        ).select_related("service", "flight").order_by("-completed_at")[:GENERATED_NOTIFICATIONS]:
            notification_service.notify_many(
                users=dispatchers,
                kind="service_confirmed",
                title=(
                    f"{order.service.name_ru}: подтверждена по рейсу {order.flight.number}"
                ),
                link=f"/flights/{order.flight_id}/services",
            )
            created += len(dispatchers)

        return created

    def _bind_two_factor(self, staff: list[User]) -> None:
        """Привязывает приложение-аутентификатор там, где его требует политика.

        Иначе администратор и финансист упираются в экран привязки и дальше
        не проходят: привязать приложение можно только изнутри системы,
        а приложения у того, кто смотрит систему, может и не быть.

        Секрет печатается оператору и складывается в `artifacts/sample-2fa.json`
        — файл не попадает в репозиторий. Это учётные данные вымышленных
        пользователей генератора, а не рабочие.
        """
        bound: dict[str, str] = {}
        for user in staff:
            if not accounts.two_factor_setup_required(user):
                continue
            setup = accounts.setup_two_factor(user)
            bound[user.username] = setup.otpauth_url
            self.stdout.write(f"второй фактор для {user.username}: {setup.otpauth_url}")

        if not bound or not settings.SAMPLE_TWO_FACTOR_FILE:
            return

        path = Path(settings.SAMPLE_TWO_FACTOR_FILE)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(bound, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as error:
            # Каталог может быть недоступен на запись — ссылки уже напечатаны,
            # и это главное. Ронять генерацию из-за файла незачем.
            self.stdout.write(f"не удалось сохранить {path}: {error}")
            return
        self.stdout.write(f"ссылки otpauth сохранены в {path}")

    def _organization(self) -> Organization:
        organization, _ = Organization.objects.get_or_create(name="ООО «Стримлайн Група»")
        return organization

    def _staff(self, organization: Organization) -> list[User]:
        users: list[User] = []
        for full_name, role, timezone in STAFF:
            last, first, patronymic = full_name.split(" ")
            username = _translit(last).lower()
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    "email": f"{username}@{GENERATED_EMAIL_DOMAIN}",
                    "first_name": f"{first} {patronymic}",
                    "last_name": last,
                    "role": role,
                    "organization": organization,
                    "timezone": timezone,
                    "timezone_mode": TimezoneMode.AIRPORT_LOCAL,
                },
            )
            if created:
                # Пароль общий и заведомо известный (GENERATED_PASSWORD).
                # В рабочей базе seed_sample недоступна.
                user.set_password(GENERATED_PASSWORD)
                user.save(update_fields=["password"])
                _record(AuditEntityType.USER, user.pk, "created", {"role": role})
            users.append(user)
        return users

    def _clients(self, organization: Organization, seed: int) -> list[Client]:
        clients: list[Client] = []
        for name in CLIENT_NAMES:
            rnd = self._rnd(seed, f"client:{name}")
            client, created = Client.objects.get_or_create(
                name=name,
                defaults={
                    "organization": organization,
                    "legal_name": f"ООО «{name}»",
                    "country": "RU",
                    "settlement_currency": rnd.choice(["RUB", "RUB", "RUB", "EUR", "USD"]),
                    "payment_mode": PaymentMode.DEFERRED,
                    "payment_defer_days": rnd.choice([7, 10, 14, 30]),
                    "is_generated": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )
            if created:
                _record(AuditEntityType.CLIENT, client.pk, "created", {"name": name})
            clients.append(client)
        return clients

    def _vendors(self, organization: Organization, seed: int) -> list[Vendor]:
        """Поставщики и их станции.

        На каждой станции у каждой категории не меньше двух поставщиков:
        иначе нечего сравнивать в мастере заказа и не к кому переназначить
        заявку после отказа.
        """
        domestic = list(
            Airport.objects.filter(icao__in=DOMESTIC_ROUTES_ICAO).values_list("icao", flat=True)
        )
        coverage: dict[str, set[str]] = {}
        for category, names in VENDOR_NAMES.items():
            if category == ServiceCategory.PERMITS:
                # Разрешения оформляет агентство, а не станция: оно работает
                # по всем направлениям.
                for name in names:
                    coverage.setdefault(name, set()).update(
                        Airport.objects.filter(icao__in=GENERATED_ROUTES_ICAO).values_list(
                            "icao", flat=True
                        )
                    )
                continue
            for icao in domestic:
                rnd = self._rnd(seed, f"coverage:{category}:{icao}")
                for name in rnd.sample(names, min(VENDORS_PER_STATION, len(names))):
                    coverage.setdefault(name, set()).add(icao)

        vendors: list[Vendor] = []
        for category, names in VENDOR_NAMES.items():
            for name in names:
                rnd = self._rnd(seed, f"vendor:{name}")
                # Часть поставщиков оказывает и смежные услуги: подбор
                # поставщика должен работать не только на одной категории.
                specializations = [category]
                if rnd.random() < SECOND_SPECIALIZATION_SHARE:
                    extra = rnd.choice([c for c in VENDOR_NAMES if c != category])
                    specializations.append(extra)
                vendors.append(
                    self._vendor(
                        organization,
                        name=name,
                        country="RU",
                        currency="RUB",
                        specializations=specializations,
                        airports=sorted(coverage.get(name, set())),
                        defer_days=rnd.choice([15, 30, 30, 45]),
                    )
                )

        known = set(Airport.objects.values_list("icao", flat=True))
        for name, country, currency, airports in FOREIGN_VENDORS:
            stations = [icao for icao in airports if icao in known]
            if not stations:
                continue
            vendors.append(
                self._vendor(
                    organization,
                    name=name,
                    country=country,
                    currency=currency,
                    specializations=list(FOREIGN_SPECIALIZATIONS),
                    airports=stations,
                    defer_days=14,
                )
            )
        return vendors

    @staticmethod
    def _vendor(
        organization: Organization,
        *,
        name: str,
        country: str,
        currency: str,
        specializations: list[str],
        airports: list[str],
        defer_days: int,
    ) -> Vendor:
        vendor, created = Vendor.objects.get_or_create(
            name=name,
            defaults={
                "organization": organization,
                "legal_name": f"ООО «{name}»" if country == "RU" else name,
                "country": country,
                "settlement_currency": currency,
                "specializations": specializations,
                "coverage_airports": airports,
                "payment_mode": PaymentMode.DEFERRED,
                "payment_defer_days": defer_days,
                "is_generated": True,
                "data_source": DataSource.SYNTHETIC,
            },
        )
        if created:
            _record(
                AuditEntityType.VENDOR,
                vendor.pk,
                "created",
                {"name": name, "specializations": specializations},
            )
        return vendor

    def _contracts(self, vendors: list[Vendor], seed: int) -> int:
        """Договоры с поставщиками `[ТЗ 3.3.3]`.

        Большинство действует; несколько истекают в ближайший месяц,
        два истекли без продления, у части есть прошлый договор. Без этого
        нечего показать ни на «светофоре», ни в проверке заказа.
        """
        today = clock.today()
        created = 0
        for index, vendor in enumerate(vendors):
            if VendorContract.objects.filter(vendor=vendor).exists():
                continue
            rnd = self._rnd(seed, f"contract:{vendor.name}")
            valid_from = today - timedelta(days=rnd.randint(150, 500))
            if index in EXPIRING_CONTRACTS:
                valid_to = today + timedelta(days=EXPIRING_CONTRACTS[index])
            elif index in EXPIRED_CONTRACTS:
                valid_to = today - timedelta(days=EXPIRED_CONTRACTS[index])
            else:
                valid_to = today + timedelta(days=rnd.randint(90, 700))

            periods = [(valid_from, valid_to)]
            if index in RENEWED_CONTRACTS:
                periods.insert(0, (valid_from - timedelta(days=365), valid_from))

            for number, (start, end) in enumerate(periods, start=1):
                contract = VendorContract.objects.create(
                    vendor=vendor,
                    number=f"{start:%Y}/{index + 1:03d}-{number}",
                    valid_from=start,
                    # Прежний договор кончается за секунду до начала нового:
                    # на любой момент действует ровно один.
                    valid_to=end - timedelta(seconds=1) if end == valid_from else end,
                    currency=vendor.settlement_currency,
                    payment_mode=vendor.payment_mode,
                    payment_defer_days=vendor.payment_defer_days,
                )
                _record(
                    AuditEntityType.CONTRACT,
                    contract.pk,
                    "created",
                    {"number": contract.number, "vendor": vendor.name},
                )
                created += 1
        return created

    def _prices(self, vendors: list[Vendor], seed: int) -> int:
        """Цены поставщиков по станциям `[ТЗ 3.2.1]`.

        У части поставщиков есть прошлый прайс: снимок цены в старых
        заявках расходится с текущим прайсом, и это должно быть видно.
        """
        today = clock.today()
        services: dict[str, list[Service]] = {}
        for service in Service.objects.filter(
            is_active=True, data_source=DataSource.IMPORTED, code__in=BASE_PRICES_RUB
        ):
            services.setdefault(service.category, []).append(service)

        created = 0
        for vendor in vendors:
            if VendorPrice.objects.filter(vendor=vendor).exists():
                continue
            rnd = self._rnd(seed, f"prices:{vendor.name}")
            vendor_factor = Decimal(str(round(rnd.uniform(0.88, 1.15), 3)))
            history = rnd.random() < PRICE_HISTORY_SHARE
            boundary = today - timedelta(days=rnd.randint(20, 60))
            for category in vendor.specializations:
                for service in services.get(category, []):
                    for icao in vendor.coverage_airports:
                        currency = FOREIGN_CURRENCY.get(icao, vendor.settlement_currency)
                        amount = _price(service.code, icao, currency, vendor_factor)
                        periods = [(boundary, today + timedelta(days=330), amount)]
                        if history:
                            periods.append(
                                (
                                    today - timedelta(days=420),
                                    boundary - timedelta(seconds=1),
                                    _quantize(amount / PRICE_INCREASE),
                                )
                            )
                        else:
                            periods = [(today - timedelta(days=420), *periods[0][1:])]
                        for start, end, value in periods:
                            VendorPrice.objects.create(
                                vendor=vendor,
                                service=service,
                                airport_icao=icao,
                                amount=value,
                                currency=currency,
                                min_charge_amount=_min_charge(service.code, value),
                                valid_from=start,
                                valid_to=end,
                                surcharges=_surcharges(service.code, currency, rnd),
                            )
                            created += 1
        return created

    def _tariffs(self, clients: list[Client], crew: Crew, seed: int) -> int:
        """Тарифы клиентов всеми тремя способами `[ТЗ 3.4.1]`."""
        today = clock.today()
        valid_from, valid_to = today - timedelta(days=400), today + timedelta(days=365)
        services = {service.code: service for service in Service.objects.all()}
        created = 0

        def rule(client: Client, **scope: Any) -> None:
            nonlocal created
            tariff_services.create_rule(
                client=client,
                service=scope.get("service"),
                category=scope.get("category", ""),
                airport_icao=scope.get("airport_icao", ""),
                mode=scope["mode"],
                markup_percent=scope.get("markup"),
                fixed_price=scope.get("fixed"),
                discount_kind=scope.get("discount_kind", ""),
                discount_value=scope.get("discount_value"),
                valid_from=valid_from,
                valid_to=valid_to,
                actor=crew.finance,
            )
            created += 1

        for client in clients:
            if TariffRule.objects.filter(client=client).exists():
                continue
            rnd = self._rnd(seed, f"tariff:{client.name}")
            for category in ServiceCategory.values:
                if category == ServiceCategory.FUEL and client.name in PASS_THROUGH_FUEL_CLIENTS:
                    rule(client, category=category, mode=TariffMode.PASS_THROUGH)
                    continue
                discount = client.name == DISCOUNT_CLIENT and category == ServiceCategory.HANDLING
                rule(
                    client,
                    category=category,
                    mode=TariffMode.COST_PLUS,
                    markup=Decimal(rnd.randint(8, 22)),
                    discount_kind="percent" if discount else "",
                    discount_value=Decimal(5) if discount else None,
                )

            if client.name == AIRPORT_RULE_CLIENT:
                rule(
                    client,
                    category=ServiceCategory.HANDLING,
                    airport_icao="UUWW",
                    mode=TariffMode.COST_PLUS,
                    markup=Decimal(10),
                )
            if client.name == FIXED_HANDLING_CLIENT and "HND_BASIC" in services:
                rule(
                    client,
                    service=services["HND_BASIC"],
                    mode=TariffMode.FIXED,
                    fixed=Money.of(FIXED_HANDLING_PRICE, "RUB"),
                )
            if client.name == NEGATIVE_MARGIN_CLIENT and "FUEL_JETA1" in services:
                rule(
                    client,
                    service=services["FUEL_JETA1"],
                    mode=TariffMode.FIXED,
                    fixed=Money.of(NEGATIVE_MARGIN_FUEL_PRICE, "RUB"),
                )
        return created

    @staticmethod
    def _sla_rules() -> None:
        """Сроки SLA по категориям `[ТЗ 3.2.3]`: без них экран SLA пуст."""
        for category, confirm, completion in SLA_RULES:
            SlaRule.objects.get_or_create(
                category=category,
                vendor=None,
                superseded_at=None,
                defaults={
                    "confirm_minutes": confirm,
                    "completion_minutes": completion,
                    "penalty_kind": SlaPenaltyKind.NONE,
                },
            )

    # ─────────────────────────── парк ───────────────────────────

    def _aircraft(self, clients: list[Client], seed: int) -> list[Aircraft]:
        bases = list(
            Airport.objects.filter(icao__in=HOME_BASES).values_list("icao", flat=True)
        ) or list(Airport.objects.values_list("icao", flat=True)[: len(HOME_BASES)])

        types = list(AircraftType.objects.exclude(category="cargo"))
        cargo_types = list(AircraftType.objects.filter(category="cargo"))
        if not types:
            return []

        aircraft: list[Aircraft] = []
        for index in range(AIRCRAFT_COUNT):
            rnd = self._rnd(seed, f"aircraft:{index}")
            # Один борт из шести — грузовой: перевозка грузов в ТЗ 3.1
            # отдельный вид рейса, и парк должен это отражать.
            pool = cargo_types if cargo_types and index % CARGO_EVERY == CARGO_EVERY - 1 else types
            aircraft_type = rnd.choice(pool)
            registration = _registration(rnd, index)

            # Состояние: большинство исправно, один-два борта в ремонте,
            # один AOG — без этого не проверить ни один сценарий срыва.
            status = AircraftStatus.SERVICEABLE
            if index == AOG_INDEX:
                status = AircraftStatus.AOG
            elif index in MAINTENANCE_INDEXES:
                status = AircraftStatus.MAINTENANCE

            item, created = Aircraft.objects.get_or_create(
                registration=registration,
                defaults={
                    "type": aircraft_type,
                    "operator": rnd.choice(clients),
                    "status": status,
                    "home_base_icao": rnd.choice(bases),
                    "is_generated": True,
                    "data_source": DataSource.SYNTHETIC,
                    "notes": "Борт в состоянии AOG: отказ системы кондиционирования"
                    if status == AircraftStatus.AOG
                    else "",
                },
            )
            if created:
                self._approvals(item, self._rnd(seed, f"approvals:{index}"))
                _record(
                    AuditEntityType.AIRCRAFT,
                    item.pk,
                    "created",
                    {"registration": registration, "status": status},
                )
            aircraft.append(item)
        return aircraft

    def _approvals(self, item: Aircraft, rnd: random.Random) -> None:
        """Допуски с разными сроками, в том числе истекающий.

        Истекающий допуск нужен намеренно: предупреждение при планировании
        рейса после даты окончания — это поведение, которое надо показывать,
        а не обсуждать на словах.
        """
        now = clock.now()
        approvals = [("RVSM", 720), ("RNP", 540)]
        if rnd.random() < EXPIRING_APPROVAL_SHARE:
            approvals.append(("CAT_II", 30))  # скоро истекает

        for kind, days_left in approvals:
            AircraftApproval.objects.create(
                aircraft=item,
                kind=kind,
                number=f"{kind}-{rnd.randint(10000, 99999)}",
                valid_from=now - timedelta(days=365),
                valid_to=now + timedelta(days=days_left),
                is_generated=True,
                data_source=DataSource.SYNTHETIC,
            )

    # ─────────────────────────── расписание ───────────────────────────

    def _flights(
        self, clients: list[Client], aircraft: list[Aircraft], crew: Crew, seed: int
    ) -> list[Flight]:
        """Расписание вокруг сегодняшнего дня.

        Каждый рейс проживает свою историю по часам: заведён за несколько
        дней, услуги заказаны, поставщики ответили, рейс вылетел, прилетел
        и закрыт счётом. Где история не дошла до конца к сегодняшнему дню,
        там и остановилась: прошедший рейс, висящий в «Запланирован»,
        выглядел бы поломкой, а будущий — ещё в работе.
        """
        airports = list(
            Airport.objects.filter(icao__in=GENERATED_ROUTES_ICAO).values_list("icao", flat=True)
        )
        if len(airports) < MIN_ROUTE_AIRPORTS or not aircraft:
            self.stdout.write("Недостаточно справочных данных для рейсов, пропущено")
            return []
        services = {
            service.code: service
            for service in Service.objects.filter(
                is_active=True, data_source=DataSource.IMPORTED, code__in=BASE_PRICES_RUB
            )
        }

        now = clock.now()
        today = clock.today()
        created: list[Flight] = []
        for offset in range(-FLIGHTS_BACK_DAYS, FLIGHTS_FORWARD_DAYS):
            for index in range(FLIGHTS_PER_DAY):
                rnd = self._rnd(seed, f"flight:{offset}:{index}")
                departure, arrival = rnd.sample(airports, 2)
                std = today + timedelta(
                    days=offset, hours=6 + index * 4, minutes=rnd.choice([0, 10, 25, 40])
                )
                # Повторный запуск не плодит рейсов: тот же слот уже занят.
                if Flight.objects.filter(
                    is_generated=True, std_utc=std, dep_icao=departure, arr_icao=arrival
                ).exists():
                    continue
                machine = _free_aircraft(aircraft, std, rnd)
                if machine is None:
                    continue

                if machine.type.category == "cargo":
                    flight_type = "cargo"
                else:
                    flight_type = rnd.choice(["charter", "charter", "charter", "ferry"])
                booked = min(
                    std - timedelta(days=rnd.randint(4, 9), hours=rnd.randint(0, 12)),
                    now - timedelta(hours=rnd.randint(2, 48)),
                )
                with clock.frozen(booked):
                    flight = planning.create_flight(
                        client=rnd.choice(clients),
                        dep_icao=departure,
                        arr_icao=arrival,
                        std_utc=std,
                        aircraft=machine,
                        flight_type=flight_type,
                        pax_count=0
                        if flight_type != "charter"
                        else rnd.randint(1, max(1, machine.type.seats)),
                        is_generated=True,
                        source=AuditSource.SEED,
                    )
                self._operate(flight, services, rnd, booked=booked, offset=offset, crew=crew)
                created.append(flight)
        return created

    def _operate(
        self,
        flight: Flight,
        services: dict[str, Service],
        rnd: random.Random,
        *,
        booked: datetime,
        offset: int,
        crew: Crew,
    ) -> None:
        """История одного рейса — до той точки, до которой дошло время."""
        now = clock.now()
        if offset >= UNPLANNED_FROM_DAY and rnd.random() < UNPLANNED_SHARE:
            return

        ordered_at = min(booked + timedelta(hours=rnd.randint(1, 8)), now - timedelta(minutes=30))
        orders = self._prepare(flight, services, rnd, ordered_at, crew, now)
        if not orders:
            return

        if rnd.random() < CANCELLED_SHARE:
            cancelled_at = min(ordered_at + timedelta(hours=rnd.randint(2, 30)), now)
            with clock.frozen(cancelled_at):
                _move(
                    flight, "cancel", reason_code="client_request", comment="Клиент перенёс поездку"
                )
            return

        quote = self._quote(flight, ordered_at + timedelta(hours=1), rnd, crew, now)
        for order in orders:
            self._answer(order, rnd, ordered_at=ordered_at, offset=offset, crew=crew, now=now)

        arrived_at = self._fly(flight, rnd, crew, now)
        if arrived_at is None:
            return
        billed_at = arrived_at + timedelta(hours=rnd.randint(3, 30))
        if billed_at > now:
            return
        with clock.frozen(billed_at):
            if self._invoice(flight, quote, crew):
                _move(flight, "complete")
            else:
                # Без курса валюты счёт не построить (ADR-039): рейс
                # закрывается явным отказом от счёта, тем же путём,
                # что у диспетчера.
                _move(
                    flight,
                    "complete",
                    comment="Счёт не выставлен: нет курса валюты на дату",
                    without_invoice=True,
                )

    def _prepare(
        self,
        flight: Flight,
        services: dict[str, Service],
        rnd: random.Random,
        ordered_at: datetime,
        crew: Crew,
        now: datetime,
    ) -> list[ServiceOrder]:
        """Заказ услуг, слоты и перевод рейса в работу."""
        orders: list[ServiceOrder] = []
        with clock.frozen(ordered_at):
            for service, leg, quantity, attributes in _service_plan(flight, services, rnd):
                order = self._order(flight, service, leg, quantity, attributes, rnd, crew)
                if order is not None:
                    orders.append(order)
            if not orders:
                return []
            self._slots(flight, rnd, past=flight.std_utc < now)
            if not _move(flight, "start"):
                return []
        return orders

    def _fly(
        self, flight: Flight, rnd: random.Random, crew: Crew, now: datetime
    ) -> datetime | None:
        """Готовность, вылет, прилёт. Возвращает момент посадки, если она была."""
        ready_at = flight.std_utc - timedelta(hours=READY_BEFORE_HOURS)
        if ready_at > now:
            return None
        with clock.frozen(ready_at):
            if not _move(flight, "ready"):
                return None

        delay = timedelta(minutes=rnd.choice(DELAYS))
        departed_at = flight.std_utc + delay
        self._execute(flight, ServiceLeg.DEPARTURE, departed_at, rnd, crew, now)
        if departed_at > now:
            return None
        with clock.frozen(departed_at):
            _move(flight, "depart")

        arrived_at = flight.sta_utc + delay + timedelta(minutes=rnd.randint(-10, 10))
        if arrived_at > now:
            return None
        with clock.frozen(arrived_at):
            _move(flight, "arrive")
        self._execute(flight, ServiceLeg.ARRIVAL, arrived_at, rnd, crew, now)
        return arrived_at

    def _order(
        self,
        flight: Flight,
        service: Service,
        leg: str,
        quantity: Decimal,
        attributes: dict[str, Any],
        rnd: random.Random,
        crew: Crew,
        *,
        avoid: str | None = None,
    ) -> ServiceOrder | None:
        """Заказ услуги у поставщика с действующими договором и ценой."""
        airport = order_services.airport_for_leg(flight, leg)
        moment = order_services.service_moment(flight, leg)
        vendors = _vendors_at(service, airport, moment, avoid=avoid)
        if not vendors:
            return None
        hours_left = (moment - clock.now()).total_seconds() / 3600
        try:
            return order_services.create_order(
                flight=flight,
                service=service,
                leg=leg,
                quantity=quantity,
                vendor=rnd.choice(vendors),
                attributes=attributes,
                override_reason=URGENT_REASON if hours_left < service.lead_time_h else "",
                actor=crew.dispatcher,
            )
        except DomainError:
            return None

    def _answer(
        self,
        order: ServiceOrder,
        rnd: random.Random,
        *,
        ordered_at: datetime,
        offset: int,
        crew: Crew,
        now: datetime,
    ) -> None:
        """Ответ поставщика: подтверждение, опоздание с ответом или отказ."""
        roll = rnd.random()
        if roll < REJECT_SHARE:
            self._reject(order, rnd, ordered_at=ordered_at, offset=offset, crew=crew, now=now)
            return

        moment = order_services.service_moment(order.flight, order.leg)
        deadline = order.sla_confirm_deadline
        late = roll < REJECT_SHARE + SLA_LATE_SHARE
        if late and deadline and deadline + timedelta(hours=4) < moment:
            # Подтверждение после срока: система фиксирует нарушение SLA.
            answered_at = deadline + timedelta(minutes=rnd.randint(20, 180))
        elif offset >= PENDING_ANSWERS_FROM_DAY and rnd.random() < PENDING_ANSWER_SHARE:
            return
        else:
            answered_at = ordered_at + timedelta(minutes=rnd.randint(4, 25))
        if answered_at > now:
            return
        with clock.frozen(answered_at):
            order_transitions.apply_transition(order, "confirm")

    def _reject(
        self,
        order: ServiceOrder,
        rnd: random.Random,
        *,
        ordered_at: datetime,
        offset: int,
        crew: Crew,
        now: datetime,
    ) -> None:
        """Отказ поставщика и переназначение заявки другому `[ТЗ 3.3.2]`."""
        rejected_at = ordered_at + timedelta(minutes=rnd.randint(10, 40))
        if rejected_at > now:
            return
        with clock.frozen(rejected_at):
            order_transitions.apply_transition(
                order, "reject", comment=rnd.choice(REJECTION_REASONS)
            )
        # Отказ по ближайшему рейсу диспетчер ещё не разобрал: рейс
        # показывает, что ему мешает.
        replaced_at = rejected_at + timedelta(minutes=rnd.randint(20, 90))
        if replaced_at > now or offset == PENDING_ANSWERS_FROM_DAY:
            return
        moment = order_services.service_moment(order.flight, order.leg)
        vendors = _vendors_at(order.service, order.airport_icao, moment, avoid=order.vendor_id)
        if not vendors:
            return
        with clock.frozen(replaced_at):
            try:
                replacement = order_services.reassign(
                    order=order,
                    vendor=rnd.choice(vendors),
                    comment=REASSIGN_COMMENT,
                    actor=crew.dispatcher,
                )
            except DomainError:
                return
        confirmed_at = replaced_at + timedelta(minutes=rnd.randint(5, 30))
        if confirmed_at <= now:
            with clock.frozen(confirmed_at):
                order_transitions.apply_transition(replacement, "confirm")

    def _execute(
        self,
        flight: Flight,
        leg: str,
        anchor: datetime,
        rnd: random.Random,
        crew: Crew,
        now: datetime,
    ) -> None:
        """Исполнение услуг плеча: начало, факт, акт, окончание.

        Услуги вылета оказываются до вылета, услуги прилёта — после посадки.
        """
        for order in flight.service_orders.filter(
            leg=leg, status=ServiceOrderStatus.CONFIRMED
        ).select_related("service", "vendor", "flight__aircraft"):
            if leg == ServiceLeg.DEPARTURE:
                started, ended = anchor - timedelta(minutes=90), anchor - timedelta(minutes=20)
            else:
                started, ended = anchor + timedelta(minutes=10), anchor + timedelta(minutes=70)
            if started > now:
                continue
            with clock.frozen(started):
                order_transitions.apply_transition(order, "begin")
            if ended > now:
                continue
            with clock.frozen(ended):
                order_services.update_order(
                    order=order,
                    changes={
                        "actual_start_at": started,
                        "actual_end_at": ended,
                        "actual_quantity": _actual_quantity(order, rnd),
                    },
                    actor=crew.dispatcher,
                )
                if order.service.requires_act_to_complete:
                    self._act(order)
                order_transitions.apply_transition(order, "finish")

    def _act(self, order: ServiceOrder) -> None:
        """Акт выполненных работ — настоящий PDF в хранилище.

        Без акта услугу с обязательным актом не закрыть: проверка автомата
        та же, что для человека.
        """
        from weasyprint import HTML

        flight = order.flight
        html = ACT_TEMPLATE.format(
            number=escape(f"{flight.number}-{order.service.code}"),
            date=f"{clock.now():%d.%m.%Y}",
            vendor=escape(order.vendor.legal_name or order.vendor.name if order.vendor else "—"),
            customer=escape(flight.organization.name),
            flight=escape(flight.number),
            airport=escape(order.airport_icao),
            registration=escape(flight.aircraft.registration if flight.aircraft else "—"),
            service=escape(order.service.name_ru),
            unit=escape(order.service.get_unit_display()),
            quantity=f"{order.actual_quantity or order.quantity:.0f}",
            start=f"{order.actual_start_at:%d.%m.%Y %H:%M}",
            end=f"{order.actual_end_at:%d.%m.%Y %H:%M}",
        )
        data: bytes = HTML(string=html).write_pdf()
        attachment_id = make_id(Attachment.id_prefix)
        file_name = f"Акт {flight.number} {order.service.code}.pdf"
        key = storage.build_key(prefix="acts", attachment_id=attachment_id, file_name=file_name)
        storage.put_bytes(key=key, data=data, mime_type="application/pdf")
        Attachment.objects.create(
            id=attachment_id,
            file_name=file_name,
            mime_type="application/pdf",
            size_bytes=len(data),
            kind=AttachmentKind.ACT,
            storage_key=key,
            uploaded_at=clock.now(),
            content_type=ContentType.objects.get_for_model(ServiceOrder),
            object_id=order.pk,
        )

    def _slots(self, flight: Flight, rnd: random.Random, *, past: bool) -> None:
        """Слот нужен только в координируемом аэропорту (ADR-026)."""
        coordinated = Airport.objects.filter(
            icao__in=[flight.dep_icao, flight.arr_icao], is_coordinated=True
        ).values_list("icao", flat=True)
        for icao in coordinated:
            is_departure = icao == flight.dep_icao
            moment = flight.std_utc if is_departure else flight.sta_utc
            # Часть слотов будущих рейсов ещё ждёт ответа координатора:
            # реестр, где всё подтверждено, не показывает ни ожидания,
            # ни разбора ответа.
            pending = not past and rnd.random() < PENDING_SLOT_SHARE
            reference = "" if pending else f"SCR-{moment:%Y}-{rnd.randint(1, 9999):04d}"
            Slot.objects.get_or_create(
                flight=flight,
                airport_icao=icao,
                type=SlotType.DEPARTURE if is_departure else SlotType.ARRIVAL,
                defaults={
                    "requested_utc": moment,
                    "confirmed_utc": None if pending else moment,
                    "status": SlotStatus.REQUESTED if pending else SlotStatus.CONFIRMED,
                    "message_number": reference,
                    "is_generated": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )

    def _conflicts(self, aircraft: list[Aircraft], clients: list[Client], seed: int) -> int:
        """Конфликты расписания, которые диспетчер должен увидеть `[ТЗ 3.1.2]`.

        Рейс на борт в AOG и рейс, пересекающийся с другим рейсом того же
        борта. Детектор конфликтов их находит сам; генератор только
        ставит такие рейсы в план.
        """
        rnd = self._rnd(seed, "conflicts")
        today = clock.today()
        created = 0
        candidates: list[tuple[Aircraft, datetime, str]] = []

        aog = next((item for item in aircraft if item.status == AircraftStatus.AOG), None)
        if aog is not None:
            candidates.append((aog, today + timedelta(days=2, hours=9), aog.home_base_icao))

        busy = (
            Flight.objects.filter(
                is_generated=True,
                std_utc__gte=today + timedelta(days=3),
                aircraft__isnull=False,
            )
            .exclude(status="cancelled")
            .order_by("std_utc")
            .first()
        )
        if busy is not None and busy.aircraft is not None:
            candidates.append((busy.aircraft, busy.std_utc + timedelta(minutes=45), busy.dep_icao))

        destinations = list(
            Airport.objects.filter(icao__in=DOMESTIC_ROUTES_ICAO).values_list("icao", flat=True)
        )
        for machine, std, departure in candidates:
            if Flight.objects.filter(aircraft=machine, std_utc=std).exists():
                continue
            others = [icao for icao in destinations if icao != departure]
            arrival = rnd.choice(others or [departure])
            with clock.frozen(clock.now() - timedelta(hours=rnd.randint(2, 20))):
                planning.create_flight(
                    client=rnd.choice(clients),
                    dep_icao=departure,
                    arr_icao=arrival,
                    std_utc=std,
                    aircraft=machine,
                    pax_count=rnd.randint(2, 8),
                    is_generated=True,
                    source=AuditSource.SEED,
                )
            created += 1
        return created

    # ─────────────────────────── документы ───────────────────────────

    def _quote(
        self, flight: Flight, at: datetime, rnd: random.Random, crew: Crew, now: datetime
    ) -> Quote | None:
        """Котировка клиенту по плану услуг `[ТЗ 3.4.1]`."""
        if at > now:
            return None
        with clock.frozen(at):
            try:
                quote = documents.build_quote(
                    flight=flight, valid_until=flight.std_utc, actor=crew.finance
                )
                documents.issue_quote(quote=quote, actor=crew.finance)
            except DomainError:
                # Нет курса валюты клиента — котировку не построить, и это
                # честнее, чем пересчитать по выдуманному курсу.
                return None
        accepted_at = at + timedelta(hours=rnd.randint(2, 20))
        if accepted_at <= now and accepted_at < flight.std_utc:
            with clock.frozen(accepted_at):
                documents.respond_to_quote(quote=quote, accepted=True, actor=crew.finance)
        return quote

    @staticmethod
    def _invoice(flight: Flight, quote: Quote | None, crew: Crew) -> Invoice | None:
        """Счёт по фактически оказанному `[ТЗ 3.4.1]`."""
        try:
            invoice = documents.build_invoice(flight=flight, quote=quote, actor=crew.finance)
            return documents.issue_invoice(invoice=invoice, actor=crew.finance)
        except DomainError:
            return None

    def _payments(self, crew: Crew, seed: int) -> int:
        """Платежи клиентов: оплачено, частично, не оплачено и просрочено."""
        now = clock.now()
        created = 0
        invoices = Invoice.objects.filter(
            is_generated=True, status__in=payment_services.PAYABLE_STATUSES
        ).select_related("client").order_by("issued_at")
        for invoice in invoices:
            rnd = self._rnd(seed, f"payment:{invoice.number}")
            roll = rnd.random()
            assert invoice.issued_at is not None
            paid_at = invoice.issued_at + timedelta(
                days=rnd.randint(1, invoice.client.payment_defer_days + 3), hours=rnd.randint(1, 8)
            )
            if roll >= PAID_SHARE + PARTIAL_SHARE or paid_at > now:
                continue
            amount = (
                invoice.total_amount
                if roll < PAID_SHARE
                else _quantize(invoice.total_amount / 2)
            )
            with clock.frozen(paid_at):
                payment_services.register(
                    client=invoice.client,
                    amount=Money.of(amount, invoice.currency),
                    received_at=paid_at,
                    allocations=[
                        payment_services.AllocationRequest(
                            invoice=invoice, amount=Money.of(amount, invoice.currency)
                        )
                    ],
                    source=PaymentSource.MANUAL,
                    external_id=f"PP-{paid_at:%y%m%d}-{rnd.randint(100, 999)}-{created + 1}",
                    comment=f"Платёжное поручение № {rnd.randint(1000, 9999)}",
                    actor=crew.finance,
                )
            created += 1

        # Срок прошёл, а денег нет — счёт просрочен. Так же статус выводит
        # фоновая проверка (ADR-019), здесь — сразу, чтобы набор был цельным.
        for invoice in Invoice.objects.filter(
            is_generated=True, status__in=payment_services.PAYABLE_STATUSES
        ):
            payment_services.refresh_status(invoice)
        return created

    def _approve_payables(self, crew: Crew, seed: int) -> None:
        """Согласование заявок на оплату поставщикам `[ТЗ 3.4.2]`.

        Оплата поставщику проводится в 1С, а не здесь: статуса «оплачена»
        генератор не ставит — его некому было бы подтвердить.
        """
        now = clock.now()
        for payable in Payable.objects.filter(
            is_generated=True, status=PayableStatus.PENDING
        ).order_by("number"):
            rnd = self._rnd(seed, f"payable:{payable.number}")
            if rnd.random() < OVERDUE_PAYABLE_SHARE:
                continue
            approved_at = max(
                payable.due_date - timedelta(days=rnd.randint(1, 6)), payable.created_at
            )
            if approved_at > now:
                continue
            with clock.frozen(approved_at):
                payable_services.approve(payable=payable, actor=crew.finance)

    def _vendor_invoices(self, crew: Crew, seed: int) -> int:
        """Счета поставщиков и их сверка `[ТЗ 3.4.2]`.

        Строки берутся из выполненных заявок поставщика. В пяти счетах
        поставщик ошибся: цена, количество, лишняя строка, неизвестный код,
        а в одном — всё сразу. Разбор делает сверка системы.
        """
        now = clock.now()
        window_start = now - timedelta(days=21)
        vendors = sorted(
            Vendor.objects.filter(is_generated=True).exclude(
                specializations__contains=[ServiceCategory.PERMITS]
            ),
            key=lambda vendor: vendor.name,
        )
        created = 0
        for vendor in vendors:
            if created >= VENDOR_INVOICES:
                break
            orders = _invoice_orders(vendor, window_start, now - timedelta(days=2))
            currencies = {order.purchase_currency for order in orders}
            if len(orders) < MIN_INVOICE_LINES or len(currencies) != 1:
                continue
            number = f"СЧ-{now:%Y}-{created + 101:04d}"
            if VendorInvoice.objects.filter(vendor=vendor, number=number).exists():
                created += 1
                continue

            rnd = self._rnd(seed, f"vendor-invoice:{vendor.name}")
            lines = [_invoice_line(order) for order in orders]
            flaws = (
                _flaws(created, len(orders))
                if created < VENDOR_INVOICES_WITH_DISCREPANCIES
                else ()
            )
            lines = _spoil(lines, flaws, rnd)
            last = max(order.completed_at for order in orders if order.completed_at)
            issued_at = last + timedelta(days=1)
            with clock.frozen(min(issued_at, now)):
                invoice = reconciliation.import_invoice(
                    vendor=vendor,
                    number=number,
                    issued_at=min(issued_at, now),
                    currency=orders[0].purchase_currency,
                    payload=lines,
                    actor=crew.finance,
                )
            # Старший счёт с расхождениями уже разобран: в реестре видно
            # и решённую сверку, и ожидающую разбора.
            if created == 1:
                for index, _item in enumerate(invoice.reconciliation["discrepancies"]):
                    with clock.frozen(min(issued_at + timedelta(days=1), now)):
                        invoice = reconciliation.resolve(
                            invoice=invoice,
                            index=index,
                            resolution="claim",
                            comment="Претензия поставщику: цена не по договору",
                            actor=crew.finance,
                        )
            created += 1
        return created

    # ─────────────────────────── прочее ───────────────────────────

    def _flight_requests(
        self, organization: Organization, clients: list[Client], seed: int
    ) -> list[FlightRequest]:
        """Заявки клиентов в очереди на подтверждение `[ТЗ 3.5.3]`."""
        airports = list(
            Airport.objects.filter(icao__in=GENERATED_ROUTES_ICAO).values_list("icao", flat=True)
        )
        if len(airports) < MIN_ROUTE_AIRPORTS:
            return []

        comments = (
            "Нужен борт с салоном на восемь мест",
            "Просим подтвердить до конца недели",
            "Обратный вылет уточним позже",
            "",
        )
        created: list[FlightRequest] = []
        for index in range(6):
            rnd = self._rnd(seed, f"request:{index}")
            departure, arrival = rnd.sample(airports, 2)
            request, was_created = FlightRequest.objects.get_or_create(
                client=rnd.choice(clients),
                dep_icao=departure,
                arr_icao=arrival,
                requested_std_utc=clock.today() + timedelta(days=index + 2, hours=9),
                defaults={
                    "organization": organization,
                    "pax_count": rnd.randint(1, 9),
                    "comment": rnd.choice(comments),
                    "is_generated": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )
            if was_created:
                created.append(request)
        return created

    def _portal_users(
        self, organization: Organization, clients: list[Client], vendors: list[Vendor]
    ) -> None:
        """По одному пользователю портала: без них не показать изоляцию данных."""
        pairs = (
            ("Лебедева Светлана Игоревна", Role.CLIENT, {"client": clients[0]}),
            ("Захаров Николай Андреевич", Role.VENDOR, {"vendor": vendors[0]}),
        )
        for full_name, role, link in pairs:
            last, first, patronymic = full_name.split(" ")
            username = _translit(last).lower()
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    "email": f"{username}@{GENERATED_EMAIL_DOMAIN}",
                    "first_name": f"{first} {patronymic}",
                    "last_name": last,
                    "role": role,
                    "organization": organization,
                    **link,
                },
            )
            if created:
                user.set_password(GENERATED_PASSWORD)
                user.save(update_fields=["password"])
                _record(AuditEntityType.USER, user.pk, "created", {"role": role})


# ─────────────────────────── вспомогательное ───────────────────────────


def _record(
    entity_type: AuditEntityType, entity_id: str, action: str, after: dict[str, Any]
) -> None:
    audit.record(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        after=after,
        source=AuditSource.SEED,
        is_generated=True,
    )


def _move(
    flight: Flight,
    name: str,
    *,
    reason_code: str = "",
    comment: str = "",
    without_invoice: bool = False,
) -> bool:
    """Переход рейса. Невыполненное условие — не ошибка генератора, а остановка истории."""
    try:
        transitions.apply_transition(
            flight,
            name,
            reason_code=reason_code,
            comment=comment,
            complete_without_invoice=without_invoice,
        )
    except DomainError:
        return False
    return True


def _free_aircraft(aircraft: list[Aircraft], std: datetime, rnd: random.Random) -> Aircraft | None:
    """Исправный борт, свободный в эти часы.

    Тот же борт в те же часы — конфликт расписания. Генератор ставит его
    намеренно и один раз (`Command._conflicts`), а не случайно.
    """
    pool = [item for item in aircraft if item.status == AircraftStatus.SERVICEABLE]
    rnd.shuffle(pool)
    for item in pool:
        if not Flight.objects.filter(
            aircraft=item,
            std_utc__gte=std - timedelta(hours=6),
            std_utc__lte=std + timedelta(hours=6),
        ).exists():
            return item
    return None


def _service_plan(
    flight: Flight, services: dict[str, Service], rnd: random.Random
) -> list[tuple[Service, str, Decimal, dict[str, Any]]]:
    """Что заказывают на рейс: топливо и обслуживание всегда, остальное — по рейсу."""
    plan: list[tuple[Service, str, Decimal, dict[str, Any]]] = []

    def add(code: str, leg: str, quantity: int, attributes: dict[str, Any]) -> None:
        if code in services:
            plan.append((services[code], leg, Decimal(quantity), attributes))

    departure, arrival = ServiceLeg.DEPARTURE, ServiceLeg.ARRIVAL
    domestic = flight.dep_icao in DOMESTIC_ROUTES_ICAO
    pax = max(flight.pax_count, 1)
    crew = rnd.randint(2, 4)
    # Плановое топливо в килограммах, заказ — в литрах при плотности 0,8.
    volume = max(MIN_FUEL_L, flight.fuel_plan_kg * 5 // 4 // 100 * 100) or DEFAULT_FUEL_L

    add(
        "FUEL_JETA1",
        departure,
        volume,
        {"fuelGrade": "TS-1" if domestic else "Jet A-1", "volumeL": volume},
    )
    add("HND_BASIC", departure, 1, {})
    add("HND_BASIC", arrival, 1, {})
    if flight.type == "cargo":
        weight = rnd.randrange(1500, 9000, 100)
        add("TRN_CARGO", arrival, weight, {"weightKg": weight})
    elif flight.type == "charter":
        if rnd.random() < PLAN_SHARES["CAT_MEAL"]:
            add(
                "CAT_MEAL",
                departure,
                pax,
                {"paxCount": pax, "menuClass": rnd.choice(["standard", "premium", "halal"])},
            )
        if rnd.random() < PLAN_SHARES["TRN_VIP"]:
            add("TRN_VIP", arrival, rnd.randint(1, 2), {"paxCount": pax, "carClass": "business"})
    if rnd.random() < PLAN_SHARES["CAT_CREW"]:
        add("CAT_CREW", departure, crew, {"paxCount": crew})
    if rnd.random() < PLAN_SHARES["HND_GPU"]:
        hours = rnd.randint(1, 3)
        add("HND_GPU", departure, hours, {"hours": hours})
    if rnd.random() < PLAN_SHARES["TRN_HOTEL"]:
        nights = rnd.randint(1, 2)
        add("TRN_HOTEL", arrival, crew * nights, {"paxCount": crew, "nights": nights})
    if domestic and rnd.random() < PLAN_SHARES["DEI_TYPE1"]:
        fluid = rnd.randrange(300, 1200, 50)
        add("DEI_TYPE1", departure, fluid, {"volumeL": fluid})
    if flight.is_international:
        # Международный рейс без разрешительного документа не выпускается
        # (DOMAIN § 5.1).
        add("PRM_LANDING", arrival, 1, {})
        add("PRM_CUSTOMS", departure, 1, {})
    return plan


def _vendors_at(
    service: Service, airport: str, moment: datetime, *, avoid: str | None
) -> list[Vendor]:
    """Поставщики с ценой и договором, действующими на момент оказания."""
    vendors: list[Vendor] = []
    for price in catalog_services.candidates_at(
        service_id=service.pk, airport_icao=airport, moment=moment
    ):
        if price.vendor_id == avoid:
            continue
        if counterparty_services.active_contract_for(vendor_id=price.vendor_id, moment=moment):
            vendors.append(price.vendor)
    return vendors


def _actual_quantity(order: ServiceOrder, rnd: random.Random) -> Decimal:
    """Факт расходится с планом у топлива и жидкости, остальное — как заказано."""
    if order.service.category in (ServiceCategory.FUEL, ServiceCategory.DEICING):
        factor = Decimal(str(round(rnd.uniform(0.9, 1.04), 3)))
        tens = (Decimal(order.quantity) * factor / 10).quantize(Decimal(1), ROUND_HALF_UP)
        return tens * 10
    return Decimal(order.quantity)


def _price(code: str, icao: str, currency: str, vendor_factor: Decimal) -> Decimal:
    rub = BASE_PRICES_RUB[code] * vendor_factor
    if icao in MOSCOW_AIRPORTS:
        rub *= Decimal("1.12")
    value = rub if currency == "RUB" else rub / FOREIGN_PRICE_DIVISOR[currency]
    return _quantize(value)


def _quantize(value: Decimal) -> Decimal:
    """Цена за литр — с копейками, за рейс и час — в целых единицах."""
    quantum = Decimal("0.01") if value < WHOLE_UNITS_FROM else Decimal(1)
    return value.quantize(quantum, rounding=ROUND_HALF_UP)


def _min_charge(code: str, amount: Decimal) -> Decimal | None:
    """Минимальная стоимость там, где поставщик не выезжает на мелочь."""
    if code in ("HND_GPU", "HND_PARK"):
        return amount * 2
    if code.startswith("DEI_"):
        return _quantize(amount * 100)
    return None


def _surcharges(code: str, currency: str, rnd: random.Random) -> list[dict[str, Any]]:
    """Сбор за заправку «в крыло» у части топливных поставщиков."""
    if code != "FUEL_JETA1" or rnd.random() >= INTO_PLANE_SHARE:
        return []
    value = "2500" if currency == "RUB" else "30"
    return [{"code": "into_plane", "kind": "fixed", "value": value}]


def _invoice_orders(vendor: Vendor, start: datetime, end: datetime) -> list[ServiceOrder]:
    """Выполненные заявки поставщика за период — все, без пропусков.

    Сверка берёт заявки в окне дат счёта ±1 день (`DOMAIN.md § 7.7`):
    окно расширяется, пока в него не перестанут попадать новые заявки,
    иначе сверка нашла бы «пропущенные» строки, которых поставщик и не
    должен был выставлять.
    """
    orders: list[ServiceOrder] = []
    for _attempt in range(5):
        found = list(
            ServiceOrder.objects.filter(
                vendor=vendor,
                status=ServiceOrderStatus.COMPLETED,
                completed_at__gte=start,
                completed_at__lte=end,
            )
            .select_related("service")
            .order_by("completed_at")
        )
        if len(found) == len(orders):
            break
        orders = found
        if not orders:
            break
        start = min(order.completed_at for order in orders if order.completed_at) - (
            reconciliation.DATE_WINDOW
        )
        end = max(order.completed_at for order in orders if order.completed_at) + (
            reconciliation.DATE_WINDOW
        )
    return orders


def _invoice_line(order: ServiceOrder) -> dict[str, Any]:
    quantity = order.actual_quantity or order.quantity
    unit = order.actual_purchase_unit_amount or order.purchase_unit_amount or Decimal(0)
    amount = order.actual_cost_amount or order.purchase_cost_amount or Decimal(0)
    return {
        "airportIcao": order.airport_icao,
        "serviceDate": order.completed_at,
        "serviceCode": order.service.code,
        "quantity": str(quantity),
        "unitPrice": {"amount": str(unit), "currency": order.purchase_currency},
        "amount": {"amount": str(amount), "currency": order.purchase_currency},
    }


def _flaws(invoice_index: int, line_count: int) -> tuple[str, ...]:
    """Ошибки поставщика в счёте с расхождениями.

    Первый счёт — со всеми тремя видами расхождений сразу (`SPEC.md § 11`),
    остальные — по одному, и в одном код услуги не из справочника.
    """
    if invoice_index == 0:
        if line_count > MIN_INVOICE_LINES:
            return ("price", "quantity", "extra", "missing")
        return ("price", "extra")
    return (("price",), ("quantity",), ("extra",), ("unmapped",))[(invoice_index - 1) % 4]


def _spoil(
    lines: list[dict[str, Any]], flaws: tuple[str, ...], rnd: random.Random
) -> list[dict[str, Any]]:
    result = [dict(line) for line in lines]
    if "missing" in flaws:
        result.pop()
    if "price" in flaws:
        line = result[0]
        unit = Decimal(line["unitPrice"]["amount"]) * Decimal("1.08")
        quantity = Decimal(line["quantity"])
        line["unitPrice"] = {**line["unitPrice"], "amount": str(_quantize(unit))}
        line["amount"] = {**line["amount"], "amount": str(_quantize(unit * quantity))}
    if "quantity" in flaws:
        line = result[1 % len(result)]
        # Топливо поставщик «перелил» на сотню литров, остальное — на единицу.
        excess = FUEL_EXCESS_L if Decimal(line["quantity"]) > FUEL_EXCESS_L else 1
        quantity = Decimal(line["quantity"]) + excess
        unit = Decimal(line["unitPrice"]["amount"])
        line["quantity"] = str(quantity)
        line["amount"] = {**line["amount"], "amount": str(_quantize(unit * quantity))}
    if "extra" in flaws:
        base = result[-1]
        currency = base["amount"]["currency"]
        price = "12000" if currency == "RUB" else "160"
        result.append(
            {
                **base,
                "serviceCode": "HND_TOW",
                "quantity": "1",
                "unitPrice": {"amount": price, "currency": currency},
                "amount": {"amount": price, "currency": currency},
            }
        )
    if "unmapped" in flaws:
        result[rnd.randrange(len(result))]["serviceCode"] = UNMAPPED_VENDOR_CODE
    return result


def _registration(rnd: random.Random, index: int) -> str:
    """Вымышленный бортовой номер с настоящим регистрационным префиксом."""
    prefix = REGISTRATION_PREFIXES[index % len(REGISTRATION_PREFIXES)]
    if prefix == "RA-":
        return f"RA-{rnd.randint(60000, 69999)}"
    letters = "".join(rnd.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(3))
    return f"{prefix}{letters}"


def _translit(text: str) -> str:
    table = {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
        "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
    return "".join(table.get(char.lower(), char) for char in text)
