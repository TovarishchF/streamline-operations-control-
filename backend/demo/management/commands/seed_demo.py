"""Демонстрационный набор данных `[ТЗ этап 2]`.

`make seed-demo`. Доступна только при `DEMO_DATA=true` (ADR-008): в боевом
режиме команда отказывается работать, чтобы придуманные контрагенты
не оказались в рабочей базе.

Правила честности (`CLAUDE.md § 4`) соблюдаются буквально:

* наименования клиентов и поставщиков вымышлены, совпадения случайны;
* реальны только общедоступные справочные данные — коды аэропортов,
  обозначения типов воздушных судов, коды валют; они приходят
  из `seed_reference` и здесь не выдумываются;
* каждая запись несёт `is_demo=True` и `data_source='synthetic'`,
  поэтому её видно в интерфейсе и можно удалить одной командой;
* записи аудита от генератора имеют `source='seed'` и автора
  «System (демо-генератор)» — они не выдаются за действия людей;
* набор генерируется относительно текущей даты, а не «историей за год».

Генератор детерминирован: один и тот же `--seed` даёт один и тот же набор.
Это нужно, чтобы снимки экранов и разговор с заказчиком воспроизводились.
"""

from __future__ import annotations

import json
import random
from datetime import timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction

from accounts import services as accounts
from accounts.models import Organization, Role, TimezoneMode, User
from audit import services as audit
from audit.models import AuditEntityType, AuditEntry, AuditSource
from catalog.models import AircraftType, Airport, Service, ServiceCategory
from comms.models import InboxMessage, Notification, OutboxMessage
from core import clock
from core.exceptions import DemoOnlyOperation, DomainError
from core.models import DataSource
from counterparties.models import Client, Contact, Vendor
from fleet.models import Aircraft, AircraftApproval, AircraftStatus
from flights.models import Flight, FlightRequest, ServiceLeg, Slot, SlotStatus, SlotType
from flights.services import planning, transitions
from orders.models import ServiceOrder, ServiceOrderStatus

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

# Сколько заявок оставить ожидающими ответа поставщика: на них
# показывается разбор входящих.
PENDING_ORDERS = 12

# Доли состояний исходящих: экран должен показывать не только «отправлено».
FAILED_MESSAGE_SHARE = 0.1
SENT_MESSAGE_SHARE = 0.7

# Сколько событий положить в колокольчик.
DEMO_NOTIFICATIONS = 6

# Доля слотов, ожидающих ответа координатора.
PENDING_SLOT_SHARE = 0.3

VENDOR_NAMES: dict[str, tuple[str, ...]] = {
    "fuel": ("Топливная Компания Восток", "Аэро Фьюэл Сервис", "Нефтепродукт Аэро", "Крыло-Ойл"),
    "handling": ("Хэндлинг Групп", "Аэросервис Столица", "Терминал Плюс", "Грин Гейт"),
    "catering": ("Небесный Стол", "Кейтеринг Аврора", "Гурмэ Флай"),
    "transport": ("Трансфер Премиум", "Автопарк Аэро", "Логистик Драйв"),
    "permits": ("Пермит Бюро", "Аэронавигация Консалт"),
    "deicing": ("Антилёд Сервис", "Дайсинг Технологии"),
}

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

# Предпочитаемые базы приписки. Берутся из справочника, а не подставляются
# как есть: код аэропорта, которого нет в справочнике, — выдуманные данные,
# а выдумывать справочные сведения нельзя (`CLAUDE.md § 4`).

# Доли и пороги генератора вынесены в константы: иначе числа в коде
# читаются как случайные, а они задают вид демонстрационного набора.
CARGO_EVERY = 6
SECOND_SPECIALIZATION_SHARE = 0.3
EXPIRING_APPROVAL_SHARE = 0.4
AIRCRAFT_COUNT = 26

# Рейсы генерируются относительно текущей даты (CLAUDE.md § 4), а не
# «историей за год»: стенд должен выглядеть работающим сегодня.
FLIGHTS_BACK_DAYS = 7
FLIGHTS_FORWARD_DAYS = 14
FLIGHTS_PER_DAY = 4
CANCELLED_SHARE = 0.1

# Маршрут собирается из пары аэропортов: меньше двух — собирать не из чего.
MIN_ROUTE_AIRPORTS = 2

# Номера бортов, которым задаётся особое состояние. Набор без единого
# неисправного борта не даёт показать ни одного сценария срыва расписания.
AOG_INDEX = 3
MAINTENANCE_INDEXES = (7, 14)

HOME_BASES = ("UUWW", "UUDD", "UUEE", "ULLI", "USSS", "UNNT", "UWWW", "URSS")

# Направления демонстрационного расписания: настоящие аэропорты, среди них
# международные — иначе не показать проверку разрешительных документов.
DEMO_ROUTES_ICAO = (
    "UUWW", "UUDD", "UUEE", "ULLI", "USSS", "UNNT", "UWWW", "URSS", "UWKD", "UHWW",
    "LFPB", "LSGG", "EGGW", "OMDB", "LTFM", "UACC", "UBBB", "UDYZ",
)


class ReferenceDataMissing(DomainError):
    """Демонстрационный набор опирается на справочники, а их нет.

    Молчаливый выход отсюда выглядел бы как успешная генерация пустого
    набора: команда отработала, а на стенде ничего не появилось.
    """

    code = "VALIDATION_ERROR"


class Command(BaseCommand):
    help = "Демонстрационный набор данных (только при DEMO_DATA=true)"

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--seed", type=int, default=20260913, help="Зерно генератора")
        parser.add_argument("--purge", action="store_true", help="Удалить демонстрационные записи")

    def handle(self, *args: Any, **options: Any) -> None:
        if not settings.DEMO_DATA:
            raise DemoOnlyOperation(
                "Команда доступна только при DEMO_DATA=true: в боевом режиме "
                "придуманные контрагенты в базе недопустимы (ADR-008)"
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
        """Удаляет только демонстрационные записи.

        Порядок обратен порядку создания: связи защищены `PROTECT`, поэтому
        сначала уходят пользователи порталов, затем борта и только потом
        контрагенты, на которых те ссылаются.
        """
        counts = {
            "пользователи": User.objects.filter(username__endswith=".demo").delete()[0],
            # Коммуникации уходят первыми: входящее ссылается на заявку,
            # уведомление — на пользователя.
            "уведомления": Notification.objects.filter(is_demo=True).delete()[0],
            "входящие": InboxMessage.objects.filter(is_demo=True).delete()[0],
            "исходящие": OutboxMessage.objects.filter(is_demo=True).delete()[0],
            "контакты": Contact.objects.filter(is_demo=True).delete()[0],
            "заявки клиентов": FlightRequest.objects.filter(is_demo=True).delete()[0],
            "заявки на услуги": ServiceOrder.objects.filter(is_demo=True).delete()[0],
            "слоты": Slot.objects.filter(is_demo=True).delete()[0],
            "рейсы": Flight.objects.filter(is_demo=True).delete()[0],
            "борта": Aircraft.objects.filter(is_demo=True).delete()[0],
            "клиенты": Client.objects.filter(is_demo=True).delete()[0],
            "поставщики": Vendor.objects.filter(is_demo=True).delete()[0],
            # Журнал неизменяем на уровне базы, и это правильно: удалять
            # записи аудита нельзя даже генератору. Демонстрационные записи
            # отличимы по source='seed' и живут до пересоздания базы.
            "записи журнала": AuditEntry.objects.filter(is_demo=True).count(),
        }
        return counts

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
                "демонстрационный набор опирается на настоящие коды аэропортов."
            )

        organization = self._organization()
        staff = self._staff(organization)
        self._bind_two_factor(staff)
        clients = self._clients(organization, seed)
        vendors = self._vendors(organization, seed)
        aircraft = self._aircraft(clients, seed)
        self._portal_users(organization, clients, vendors)
        flights = self._flights(clients, aircraft, vendors, seed)
        requests = self._flight_requests(organization, clients, seed)
        self._contacts(clients, vendors, seed)
        messages = self._communications(staff, seed)

        return {
            "клиенты": len(clients),
            "поставщики": len(vendors),
            "борта": len(aircraft),
            "сотрудники": len(staff),
            "рейсы": len(flights),
            "заявки клиентов": len(requests),
            "сообщения и уведомления": messages,
        }

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
                email=f"ops@{_translit(owner.name)[:18]}.test",
                phone=f"+7 495 {rnd.randint(100, 999)}-{rnd.randint(10, 99)}-{rnd.randint(10, 99)}",
                # Часть контрагентов переписывается по-английски: язык письма
                # выбирается по контакту, и это надо показывать.
                locale="en" if rnd.random() < ENGLISH_CONTACT_SHARE else "ru",
                is_primary=True,
                is_demo=True,
                data_source=DataSource.SYNTHETIC,
            )

    def _communications(self, staff: list[User], seed: int) -> int:
        """Переписка и уведомления на стенде `[ТЗ 3.5.1, 3.5.2, 3.2.2]`.

        Заявки, ожидающие ответа поставщика, оставляются нарочно: без них
        входящие пусты, а именно на них показывается разбор писем.
        Сообщения помечены `source='seed'` и за действия людей не выдаются.
        """
        from comms.services import inbox as inbox_service
        from comms.services import notifications as notification_service
        from comms.services import outbox as outbox_service

        rnd = self._rnd(seed, "communications")
        created = 0

        # Часть подтверждённых заявок возвращается в «Заказана»: поставщик
        # ещё не ответил. Статус меняется прямой записью, как и остальной
        # набор генератора, — это данные стенда, а не действие пользователя.
        pending = list(
            ServiceOrder.objects.filter(
                status=ServiceOrderStatus.CONFIRMED, vendor__isnull=False
            ).order_by("pk")[:PENDING_ORDERS]
        )
        ServiceOrder.objects.filter(pk__in=[item.pk for item in pending]).update(
            status=ServiceOrderStatus.ORDERED,
            confirmed_at=None,
            sla_confirm_deadline=clock.now() + timedelta(hours=4),
        )

        for order in ServiceOrder.objects.filter(
            pk__in=[item.pk for item in pending]
        ).select_related("vendor", "service", "flight"):
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
                is_demo=True,
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
            status=ServiceOrderStatus.COMPLETED
        ).select_related("service", "flight")[:DEMO_NOTIFICATIONS]:
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

        Иначе администратор и финансист на стенде упираются в экран привязки
        и дальше не проходят: привязать приложение можно только изнутри
        системы, а приложения у того, кто смотрит стенд, может и не быть.

        Секрет печатается оператору и складывается в `artifacts/demo-2fa.json`
        — файл не попадает в репозиторий. Это учётные данные вымышленных
        пользователей демонстрационного стенда, а не боевые.
        """
        bound: dict[str, str] = {}
        for user in staff:
            if not accounts.two_factor_setup_required(user):
                continue
            setup = accounts.setup_two_factor(user)
            bound[user.username] = setup.otpauth_url
            self.stdout.write(f"второй фактор для {user.username}: {setup.otpauth_url}")

        if not bound or not settings.DEMO_TWO_FACTOR_FILE:
            return

        path = Path(settings.DEMO_TWO_FACTOR_FILE)
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
            username = f"{_translit(last).lower()}.demo"
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    "email": f"{_translit(last).lower()}@demo.local",
                    "first_name": f"{first} {patronymic}",
                    "last_name": last,
                    "role": role,
                    "organization": organization,
                    "timezone": timezone,
                    "timezone_mode": TimezoneMode.AIRPORT_LOCAL,
                },
            )
            if created:
                # Пароль общий и заведомо известный: это демонстрационный
                # стенд, а не боевая система. В бою seed_demo недоступна.
                user.set_password("demo-stand-2026-parol")
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
                    "is_demo": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )
            if created:
                _record(AuditEntityType.CLIENT, client.pk, "created", {"name": name})
            clients.append(client)
        return clients

    def _vendors(self, organization: Organization, seed: int) -> list[Vendor]:
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

                vendor, created = Vendor.objects.get_or_create(
                    name=name,
                    defaults={
                        "organization": organization,
                        "legal_name": f"ООО «{name}»",
                        "country": "RU",
                        "settlement_currency": "RUB",
                        "specializations": specializations,
                        "is_demo": True,
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
                vendors.append(vendor)
        return vendors

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
                    "is_demo": True,
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
                is_demo=True,
                data_source=DataSource.SYNTHETIC,
            )

    def _flights(
        self,
        clients: list[Client],
        aircraft: list[Aircraft],
        vendors: list[Vendor],
        seed: int,
    ) -> list[Flight]:
        """Расписание вокруг сегодняшнего дня.

        Набор подбирается так, чтобы на стенде не приходилось угадывать,
        какое сочетание сработает: есть рейсы в каждом состоянии автомата,
        международные и внутренние, с заявками на услуги и без.
        """
        airports = list(
            Airport.objects.filter(icao__in=DEMO_ROUTES_ICAO).values_list("icao", flat=True)
        )
        # По одной услуге на категорию: набор должен покрывать и
        # разрешительные документы, иначе международные рейсы не взлетят.
        services = [
            service
            for category in ServiceCategory.values
            if (service := Service.objects.filter(category=category).first()) is not None
        ]
        if len(airports) < MIN_ROUTE_AIRPORTS or not aircraft:
            self.stdout.write("Недостаточно справочных данных для рейсов, пропущено")
            return []

        today = clock.now().replace(hour=0, minute=0, second=0, microsecond=0)
        created: list[Flight] = []

        for offset in range(-FLIGHTS_BACK_DAYS, FLIGHTS_FORWARD_DAYS):
            for index in range(FLIGHTS_PER_DAY):
                rnd = self._rnd(seed, f"flight:{offset}:{index}")
                departure, arrival = rnd.sample(airports, 2)
                machine = rnd.choice(aircraft)
                if machine.status != AircraftStatus.SERVICEABLE:
                    continue

                std = today + timedelta(
                    days=offset, hours=6 + index * 4, minutes=rnd.choice([0, 10, 25, 40])
                )
                # Тот же борт в те же часы — это конфликт расписания, а не
                # демонстрация: пусть он будет заведомо редким и намеренным.
                if Flight.objects.filter(
                    aircraft=machine,
                    std_utc__gte=std - timedelta(hours=6),
                    std_utc__lte=std + timedelta(hours=6),
                ).exists():
                    continue

                flight = planning.create_flight(
                    client=rnd.choice(clients),
                    dep_icao=departure,
                    arr_icao=arrival,
                    std_utc=std,
                    aircraft=machine,
                    flight_type=rnd.choice(
                        ["charter", "charter", "charter", "cargo", "ferry"]
                    ),
                    pax_count=rnd.randint(1, max(1, machine.type.seats)),
                    is_demo=True,
                    source=AuditSource.SEED,
                )
                self._advance(flight, services, vendors, rnd, offset)
                created.append(flight)
        return created

    def _advance(
        self,
        flight: Flight,
        services: list[Service],
        vendors: list[Vendor],
        rnd: random.Random,
        offset: int,
    ) -> None:
        """Доводит рейс до состояния, соответствующего его дате.

        Прошедший рейс, висящий в «Запланирован», выглядит поломкой: на стенде
        каждая такая мелочь читается как недоделка, а не как условность.
        """
        if not services:
            return

        legs = (
            (ServiceLeg.DEPARTURE, flight.dep_icao),
            (ServiceLeg.ARRIVAL, flight.arr_icao),
        )
        ordinary = [item for item in services if item.category != ServiceCategory.PERMITS]
        for leg, icao in legs:
            for service in rnd.sample(ordinary, min(2, len(ordinary))):
                ServiceOrder.objects.create(
                    flight=flight,
                    service=service,
                    leg=leg,
                    airport_icao=icao,
                    vendor=rnd.choice(vendors) if vendors else None,
                    quantity=rnd.randint(1, 4),
                    is_demo=True,
                    data_source=DataSource.SYNTHETIC,
                )

        # Международный рейс без разрешительного документа не выпускается
        # (DOMAIN § 5.1). Без этой заявки половина расписания на стенде
        # застревала бы в «В работе», и понять почему было бы нельзя.
        permit = next(
            (item for item in services if item.category == ServiceCategory.PERMITS), None
        )
        if permit is not None and flight.is_international:
            ServiceOrder.objects.create(
                flight=flight,
                service=permit,
                leg=ServiceLeg.DEPARTURE,
                airport_icao=flight.dep_icao,
                vendor=rnd.choice(vendors) if vendors else None,
                quantity=1,
                is_demo=True,
                data_source=DataSource.SYNTHETIC,
            )

        # Слот нужен только в координируемом аэропорту (ADR-026).
        coordinated = Airport.objects.filter(
            icao__in=[flight.dep_icao, flight.arr_icao], is_coordinated=True
        ).values_list("icao", flat=True)
        for icao in coordinated:
            is_departure = icao == flight.dep_icao
            moment = flight.std_utc if is_departure else flight.sta_utc
            # Часть слотов ещё ждёт ответа координатора: реестр, где всё
            # подтверждено, не показывает ни ожидания, ни разбора ответа.
            pending = rnd.random() < PENDING_SLOT_SHARE
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
                    "is_demo": True,
                    "data_source": DataSource.SYNTHETIC,
                },
            )

        def move(name: str, reason_code: str = "", comment: str = "") -> bool:
            try:
                transitions.apply_transition(
                    flight,
                    name,
                    source=AuditSource.SEED,
                    reason_code=reason_code,
                    comment=comment,
                )
            except DomainError:
                return False
            return True

        # Один рейс из десяти отменён: расписание без единой отмены
        # неправдоподобно, а отмена — сценарий, который надо показывать.
        if rnd.random() < CANCELLED_SHARE:
            move("cancel", reason_code="client_request", comment="Клиент перенёс поездку")
            return

        if not move("start"):
            return
        flight.service_orders.update(status=ServiceOrderStatus.CONFIRMED)

        # Будущим рейсам ещё готовиться: они остаются в работе.
        if offset > 1 or not move("ready") or offset > 0:
            return
        if not move("depart") or offset == 0:
            return
        move("arrive")
        flight.service_orders.update(status=ServiceOrderStatus.COMPLETED)
        move("complete")

    def _flight_requests(
        self, organization: Organization, clients: list[Client], seed: int
    ) -> list[FlightRequest]:
        """Заявки клиентов в очереди на подтверждение `[ТЗ 3.5.3]`."""
        airports = list(
            Airport.objects.filter(icao__in=DEMO_ROUTES_ICAO).values_list("icao", flat=True)
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
                requested_std_utc=clock.now() + timedelta(days=index + 2, hours=9),
                defaults={
                    "organization": organization,
                    "pax_count": rnd.randint(1, 9),
                    "comment": rnd.choice(comments),
                    "is_demo": True,
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
            ("klient.demo", Role.CLIENT, {"client": clients[0]}),
            ("postavshchik.demo", Role.VENDOR, {"vendor": vendors[0]}),
        )
        for username, role, link in pairs:
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    "email": f"{username}@demo.local",
                    "first_name": "Демонстрационный",
                    "last_name": "Пользователь",
                    "role": role,
                    "organization": organization,
                    **link,
                },
            )
            if created:
                user.set_password("demo-stand-2026-parol")
                user.save(update_fields=["password"])
                _record(AuditEntityType.USER, user.pk, "created", {"role": role})


def _record(
    entity_type: AuditEntityType, entity_id: str, action: str, after: dict[str, Any]
) -> None:
    audit.record(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        after=after,
        source=AuditSource.SEED,
        is_demo=True,
    )


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
