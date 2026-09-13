"""Карта прав `[ТЗ 4.3]`.

Единый источник истины с клиентами (`BACKEND.md § 6`): карта отдаётся
в `/auth/me`, веб-клиент и мобильное приложение по ней прячут элементы
интерфейса. Прятать — не значит запрещать: проверка на сервере обязательна
в каждом эндпоинте, иначе достаточно открыть консоль браузера.

Право отвечает на вопрос «можно ли вообще», а не «к чьим записям».
Ограничение «только свои» из `SPEC.md § 2.2` — это не право, а фильтрация
выборки: она живёт в `core.api.viewsets.TenantScopedViewSet` и работает
в `get_queryset()`. Смешивать их нельзя: право, выданное с оговоркой
«к своим», в списочном эндпоинте протекает.
"""

from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _

from accounts.models import Role


class Permission(models.TextChoices):
    """Разрешения. Разбиение — по разделам матрицы `SPEC.md § 2.2`."""

    FLIGHTS_READ = "flights.read", _("Суточный план, чтение")
    FLIGHTS_WRITE = "flights.write", _("Создание и изменение рейса")
    FLIGHTS_STATUS = "flights.status", _("Смена статуса рейса")

    # Клиент не создаёт рейс напрямую: он подаёт заявку, диспетчер
    # подтверждает её, и только тогда появляется рейс (SPEC § 2.2, сноска).
    FLIGHT_REQUESTS_CREATE = "flight_requests.create", _("Подача заявки на рейс")
    FLIGHT_REQUESTS_REVIEW = "flight_requests.review", _("Рассмотрение заявок на рейс")

    ORDERS_CREATE = "orders.create", _("Заказ услуг")
    ORDERS_REQUEST = "orders.request", _("Запрос услуги заявкой")
    ORDERS_CONFIRM = "orders.confirm", _("Подтверждение услуги")

    CATALOG_READ = "catalog.read", _("Каталог услуг и цены, чтение")
    CATALOG_WRITE = "catalog.write", _("Каталог услуг и цены, изменение")

    VENDORS_READ = "vendors.read", _("Реестр поставщиков, чтение")
    VENDORS_WRITE = "vendors.write", _("Реестр поставщиков, изменение")

    CONTRACTS_READ = "contracts.read", _("Контракты, чтение")
    CONTRACTS_WRITE = "contracts.write", _("Контракты, изменение")

    TARIFFS_READ = "tariffs.read", _("Тарифы клиентов, чтение")
    TARIFFS_WRITE = "tariffs.write", _("Тарифы клиентов, изменение")

    BILLING_READ = "billing.read", _("Котировки и счета, чтение")
    BILLING_WRITE = "billing.write", _("Котировки и счета, изменение")

    PAYABLES_READ = "payables.read", _("Заявки на оплату, чтение")
    PAYABLES_WRITE = "payables.write", _("Заявки на оплату, изменение")

    RECONCILIATION_WRITE = "reconciliation.write", _("Сверка счетов")

    REPORTS_DISPATCHER = "reports.dispatcher", _("Дашборд диспетчера")
    REPORTS_FINANCE = "reports.finance", _("Финансовые отчёты")
    REPORTS_VENDOR = "reports.vendor", _("Отчёты по своим услугам")
    REPORTS_ALL = "reports.all", _("Все отчёты")

    AUDIT_READ = "audit.read", _("Журнал действий")

    USERS_MANAGE = "users.manage", _("Управление пользователями")
    SETTINGS_WRITE = "settings.write", _("Настройки системы")
    INTEGRATIONS_MANAGE = "integrations.manage", _("Внешние подключения")


P = Permission

# Матрица из `SPEC.md § 2.2`, строка в строку. Значение «только свои»
# превращается в выданное право плюс фильтрацию выборки, значение
# «заявка» — в отдельное право на подачу заявки.
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    Role.ADMIN: frozenset(Permission.values),
    Role.DISPATCHER: frozenset({
        P.FLIGHTS_READ, P.FLIGHTS_WRITE, P.FLIGHTS_STATUS,
        P.FLIGHT_REQUESTS_REVIEW,
        P.ORDERS_CREATE, P.ORDERS_CONFIRM,
        P.CATALOG_READ,
        P.VENDORS_READ,
        P.CONTRACTS_READ,
        P.BILLING_READ,
        P.REPORTS_DISPATCHER,
    }),
    Role.FINANCE: frozenset({
        P.FLIGHTS_READ,
        P.CATALOG_READ, P.CATALOG_WRITE,
        P.VENDORS_READ,
        P.CONTRACTS_READ, P.CONTRACTS_WRITE,
        P.TARIFFS_READ, P.TARIFFS_WRITE,
        P.BILLING_READ, P.BILLING_WRITE,
        P.PAYABLES_READ, P.PAYABLES_WRITE,
        P.RECONCILIATION_WRITE,
        P.REPORTS_FINANCE,
    }),
    Role.MANAGER: frozenset({
        P.FLIGHTS_READ,
        P.CATALOG_READ,
        P.VENDORS_READ,
        P.CONTRACTS_READ,
        P.TARIFFS_READ,
        P.BILLING_READ,
        P.PAYABLES_READ,
        P.REPORTS_ALL, P.REPORTS_DISPATCHER, P.REPORTS_FINANCE,
        P.AUDIT_READ,
    }),
    # ADR-011, требует подтверждения заказчика (G-06). Роль объявлена
    # в карте прав, но пользователи с ней не создаются до ответа.
    Role.SALES: frozenset({
        P.FLIGHTS_READ,
        P.CATALOG_READ,
        P.TARIFFS_READ,
        P.BILLING_READ, P.BILLING_WRITE,
        P.REPORTS_FINANCE,
    }),
    # Порталы. Право выдано, видимость ограничена фильтрацией выборки.
    Role.CLIENT: frozenset({
        P.FLIGHTS_READ,
        P.FLIGHT_REQUESTS_CREATE,
        P.ORDERS_REQUEST,
        P.TARIFFS_READ,
        P.BILLING_READ,
    }),
    Role.VENDOR: frozenset({
        P.ORDERS_CONFIRM,
        P.CATALOG_READ,
        P.VENDORS_READ,
        P.CONTRACTS_READ,
        P.PAYABLES_READ,
        P.REPORTS_VENDOR,
    }),
}

# Роли, ограниченные своими записями (`BACKEND.md § 3.7`). Обращение
# к чужой записи даёт 404, а не 403: существование чужой записи не раскрывается.
TENANT_SCOPED_ROLES = frozenset({Role.CLIENT, Role.VENDOR})

# Перечень ролей, для которых второй фактор обязателен, задан настройкой
# TWO_FACTOR_REQUIRED_ROLES (`BACKEND.md § 6`: «настраивается»).


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def permission_map(role: str) -> dict[str, bool]:
    """Карта для `/auth/me`: перечислены все права, а не только выданные.

    Клиент должен уметь отличить «права нет» от «право появилось в новой
    версии сервера и клиент о нём не знает».
    """
    granted = permissions_for(role)
    return {value: value in granted for value in Permission.values}


def has_permission(role: str, permission: Permission | str) -> bool:
    return str(permission) in permissions_for(role)
