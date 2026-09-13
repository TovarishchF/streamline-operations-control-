/**
 * Перечень прав `[ТЗ 4.3]`.
 *
 * Значения приходят с сервера в `/auth/me` — здесь только перечень, чтобы
 * опечатка в названии права ловилась при сборке, а не в работающем интерфейсе.
 * Источник истины — `backend/accounts/permissions.py`; совпадение перечней
 * проверяется тестом `backend/tests/test_permission_map.py`.
 *
 * **Скрытие элемента в интерфейсе не заменяет проверку на сервере.** Проверка
 * в каждом эндпоинте обязательна и возвращает 403; эта карта управляет только
 * видимостью (`SPEC.md § 2.3`).
 */

export const PERMISSIONS = [
  // Операции
  'schedule.view',
  'flight.create',
  'flight.edit',
  'flight.status',
  'flight.request', // клиент создаёт заявку, а не рейс
  'request.approve',
  // Услуги
  'service.order',
  'service.confirm',
  'service.confirm.own', // поставщик подтверждает только свои
  'catalog.view',
  'catalog.edit',
  // Контрагенты
  'vendor.view',
  'vendor.edit',
  'vendor.assign',
  'contract.view',
  'contract.edit',
  'client.view',
  'client.edit',
  'tariff.view',
  'tariff.edit',
  // Финансы
  'billing.documents.view',
  'billing.documents.edit',
  'billing.payables.view',
  'billing.payables.edit',
  'billing.reconciliation',
  'billing.margin.view',
  'billing.purchase_price.view', // закупочные цены — не для клиента
  // Коммуникации
  'comms.view',
  'comms.templates.edit',
  // Отчётность
  'reports.operational',
  'reports.financial',
  'reports.vendor.own',
  'dashboard.dispatcher',
  'dashboard.manager',
  // Администрирование
  'audit.view',
  'admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Readonly<Record<Permission, boolean>>;
