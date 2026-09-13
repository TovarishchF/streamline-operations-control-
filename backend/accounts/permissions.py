"""Карта прав `[ТЗ 4.3]`.

Единый источник истины с клиентами (`BACKEND.md § 6`): карта отдаётся
в `/auth/me`, веб-клиент и мобильное приложение по ней прячут элементы
интерфейса. Прятать — не значит запрещать: проверка на сервере обязательна
в каждом эндпоинте, иначе достаточно открыть консоль браузера.

Названия прав совпадают с перечнем в `web/src/shared/auth/permissions.ts`
буква в букву. Совпадение проверяется тестом `tests/test_permission_map.py`:
две карты прав, живущие своей жизнью, — это разрешение, выданное на одной
стороне и забытое на другой.

Право отвечает на вопрос «можно ли вообще», а не «к чьим записям».
Ограничение «только свои» из `SPEC.md § 2.2` — это не право, а фильтрация
выборки: она живёт в `core.api.viewsets.TenantScopedMixin` и работает
в `get_queryset()`. Смешивать их нельзя: право, выданное с оговоркой
«к своим», в списочном эндпоинте протекает.
"""

from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _

from accounts.models import Role


class Permission(models.TextChoices):
    """Разрешения. Разбиение — по разделам матрицы `SPEC.md § 2.2`."""

    # Операции
    SCHEDULE_VIEW = "schedule.view", _("Суточный план, чтение")
    FLIGHT_CREATE = "flight.create", _("Создание рейса")
    FLIGHT_EDIT = "flight.edit", _("Изменение рейса")
    FLIGHT_STATUS = "flight.status", _("Смена статуса рейса")
    # Клиент не создаёт рейс напрямую: он подаёт заявку, диспетчер
    # подтверждает её, и только тогда появляется рейс (SPEC § 2.2, сноска).
    FLIGHT_REQUEST = "flight.request", _("Подача заявки на рейс")
    REQUEST_APPROVE = "request.approve", _("Рассмотрение заявок на рейс")

    # Услуги
    SERVICE_ORDER = "service.order", _("Заказ услуг")
    SERVICE_CONFIRM = "service.confirm", _("Подтверждение услуги")
    SERVICE_CONFIRM_OWN = "service.confirm.own", _("Подтверждение своих услуг")
    CATALOG_VIEW = "catalog.view", _("Каталог услуг и цены, чтение")
    CATALOG_EDIT = "catalog.edit", _("Каталог услуг и цены, изменение")

    # Контрагенты
    VENDOR_VIEW = "vendor.view", _("Реестр поставщиков, чтение")
    VENDOR_EDIT = "vendor.edit", _("Реестр поставщиков, изменение")
    VENDOR_ASSIGN = "vendor.assign", _("Выбор поставщика для заявки")
    CONTRACT_VIEW = "contract.view", _("Контракты, чтение")
    CONTRACT_EDIT = "contract.edit", _("Контракты, изменение")
    CLIENT_VIEW = "client.view", _("Клиенты, чтение")
    CLIENT_EDIT = "client.edit", _("Клиенты, изменение")
    TARIFF_VIEW = "tariff.view", _("Тарифы клиентов, чтение")
    TARIFF_EDIT = "tariff.edit", _("Тарифы клиентов, изменение")

    # Финансы
    BILLING_DOCUMENTS_VIEW = "billing.documents.view", _("Котировки и счета, чтение")
    BILLING_DOCUMENTS_EDIT = "billing.documents.edit", _("Котировки и счета, изменение")
    BILLING_PAYABLES_VIEW = "billing.payables.view", _("Заявки на оплату, чтение")
    BILLING_PAYABLES_EDIT = "billing.payables.edit", _("Заявки на оплату, изменение")
    BILLING_RECONCILIATION = "billing.reconciliation", _("Сверка счетов")
    BILLING_MARGIN_VIEW = "billing.margin.view", _("Маржа рейса")
    # Закупочная цена — не для клиента: он видит цену продажи.
    BILLING_PURCHASE_PRICE_VIEW = "billing.purchase_price.view", _("Закупочные цены")

    # Коммуникации
    COMMS_VIEW = "comms.view", _("Переписка и уведомления")
    COMMS_TEMPLATES_EDIT = "comms.templates.edit", _("Шаблоны сообщений")

    # Отчётность
    REPORTS_OPERATIONAL = "reports.operational", _("Операционные отчёты")
    REPORTS_FINANCIAL = "reports.financial", _("Финансовые отчёты")
    REPORTS_VENDOR_OWN = "reports.vendor.own", _("Отчёты по своим услугам")
    DASHBOARD_DISPATCHER = "dashboard.dispatcher", _("Дашборд диспетчера")
    DASHBOARD_MANAGER = "dashboard.manager", _("Дашборд руководителя")

    # Администрирование
    AUDIT_VIEW = "audit.view", _("Журнал действий")
    ADMIN = "admin", _("Администрирование")


P = Permission

# Матрица из `SPEC.md § 2.2`, строка в строку. Значение «только свои»
# превращается в выданное право плюс фильтрацию выборки, значение
# «заявка» — в отдельное право на подачу заявки.
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    Role.ADMIN: frozenset(Permission.values),
    Role.DISPATCHER: frozenset({
        P.SCHEDULE_VIEW, P.FLIGHT_CREATE, P.FLIGHT_EDIT, P.FLIGHT_STATUS,
        P.REQUEST_APPROVE,
        P.SERVICE_ORDER, P.SERVICE_CONFIRM,
        P.CATALOG_VIEW,
        P.VENDOR_VIEW, P.VENDOR_ASSIGN,
        P.CONTRACT_VIEW,
        P.CLIENT_VIEW,
        P.BILLING_DOCUMENTS_VIEW, P.BILLING_MARGIN_VIEW, P.BILLING_PURCHASE_PRICE_VIEW,
        P.COMMS_VIEW,
        P.REPORTS_OPERATIONAL,
        P.DASHBOARD_DISPATCHER,
    }),
    # ADR-011, требует подтверждения заказчика (G-06). Роль объявлена
    # в карте прав, но пользователи с ней не создаются до ответа.
    Role.SALES: frozenset({
        P.SCHEDULE_VIEW,
        P.CLIENT_VIEW,
        P.TARIFF_VIEW,
        P.CATALOG_VIEW,
        P.BILLING_DOCUMENTS_VIEW, P.BILLING_DOCUMENTS_EDIT,
        P.COMMS_VIEW,
        P.REPORTS_FINANCIAL,
    }),
    Role.FINANCE: frozenset({
        P.SCHEDULE_VIEW,
        P.CATALOG_VIEW, P.CATALOG_EDIT,
        P.VENDOR_VIEW,
        P.CONTRACT_VIEW, P.CONTRACT_EDIT,
        P.CLIENT_VIEW, P.CLIENT_EDIT,
        P.TARIFF_VIEW, P.TARIFF_EDIT,
        P.BILLING_DOCUMENTS_VIEW, P.BILLING_DOCUMENTS_EDIT,
        P.BILLING_PAYABLES_VIEW, P.BILLING_PAYABLES_EDIT,
        P.BILLING_RECONCILIATION,
        P.BILLING_MARGIN_VIEW, P.BILLING_PURCHASE_PRICE_VIEW,
        P.COMMS_VIEW,
        P.REPORTS_FINANCIAL,
    }),
    Role.MANAGER: frozenset({
        P.SCHEDULE_VIEW,
        P.CATALOG_VIEW,
        P.VENDOR_VIEW,
        P.CONTRACT_VIEW,
        P.CLIENT_VIEW,
        P.TARIFF_VIEW,
        P.BILLING_DOCUMENTS_VIEW, P.BILLING_PAYABLES_VIEW,
        P.BILLING_MARGIN_VIEW, P.BILLING_PURCHASE_PRICE_VIEW,
        P.COMMS_VIEW,
        P.REPORTS_OPERATIONAL, P.REPORTS_FINANCIAL,
        P.DASHBOARD_DISPATCHER, P.DASHBOARD_MANAGER,
        P.AUDIT_VIEW,
    }),
    # Порталы. Право выдано, видимость ограничена фильтрацией выборки:
    # закупочных цен и данных поставщиков в ответе нет по построению,
    # а не по фильтрации на клиенте.
    Role.CLIENT: frozenset({
        P.SCHEDULE_VIEW,
        P.FLIGHT_REQUEST,
        P.BILLING_DOCUMENTS_VIEW,
    }),
    Role.VENDOR: frozenset({
        P.SERVICE_CONFIRM_OWN,
        P.BILLING_PAYABLES_VIEW,
        P.REPORTS_VENDOR_OWN,
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
