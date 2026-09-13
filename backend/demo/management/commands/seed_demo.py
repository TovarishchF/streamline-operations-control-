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

import random
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction

from accounts.models import Organization, Role, TimezoneMode, User
from audit import services as audit
from audit.models import AuditEntityType, AuditEntry, AuditSource
from catalog.models import AircraftType, Airport
from core import clock
from core.exceptions import DemoOnlyOperation
from core.models import DataSource
from counterparties.models import Client, Vendor
from fleet.models import Aircraft, AircraftApproval, AircraftStatus

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

# Номера бортов, которым задаётся особое состояние. Набор без единого
# неисправного борта не даёт показать ни одного сценария срыва расписания.
AOG_INDEX = 3
MAINTENANCE_INDEXES = (7, 14)

HOME_BASES = ("UUWW", "UUDD", "UUEE", "ULLI", "USSS", "UNNT", "UWWW", "URSS")


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

        if options["purge"]:
            self._purge()
            return

        self._generate(int(options["seed"]))

    # ─────────────────────────── очистка ───────────────────────────

    @transaction.atomic
    def _purge(self) -> None:
        """Удаляет только демонстрационные записи.

        Порядок обратен порядку создания: связи защищены `PROTECT`, поэтому
        сначала уходят пользователи порталов, затем борта и только потом
        контрагенты, на которых те ссылаются.
        """
        counts = {
            "пользователи": User.objects.filter(username__endswith=".demo").delete()[0],
            "борта": Aircraft.objects.filter(is_demo=True).delete()[0],
            "клиенты": Client.objects.filter(is_demo=True).delete()[0],
            "поставщики": Vendor.objects.filter(is_demo=True).delete()[0],
            # Журнал неизменяем на уровне базы, и это правильно: удалять
            # записи аудита нельзя даже генератору. Демонстрационные записи
            # отличимы по source='seed' и живут до пересоздания базы.
            "записи журнала": AuditEntry.objects.filter(is_demo=True).count(),
        }
        for name, count in counts.items():
            self.stdout.write(f"{name}: {count}")
        self.stdout.write(
            "Записи журнала не удаляются: таблица аудита только пополняется "
            "(BACKEND.md § 3.9)."
        )

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
    def _generate(self, seed: int) -> None:
        if not Airport.objects.exists():
            self.stdout.write(
                "Справочники пусты. Сначала: make seed-reference — "
                "демонстрационный набор опирается на настоящие коды аэропортов."
            )
            return

        organization = self._organization()
        staff = self._staff(organization)
        clients = self._clients(organization, seed)
        vendors = self._vendors(organization, seed)
        aircraft = self._aircraft(clients, seed)
        self._portal_users(organization, clients, vendors)

        self.stdout.write(
            f"Создано: клиентов {len(clients)}, поставщиков {len(vendors)}, "
            f"бортов {len(aircraft)}, сотрудников {len(staff)}"
        )
        self.stdout.write(
            "Рейсы и заявки появятся вместе с соответствующими модулями (M4, M5)."
        )

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
