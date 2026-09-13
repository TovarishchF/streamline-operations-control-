/**
 * Карта прав `роль → (право → boolean)`.
 *
 * `SPEC.md § 2.2`. Источник истины — сервер: на M3 карта будет приходить
 * в `/auth/me` и генерироваться из `accounts/permissions.py`. Здесь она задана
 * статически, чтобы макеты показывали навигацию так же, как будет в бою.
 *
 * **Скрытие элемента в интерфейсе не заменяет проверку на сервере.** Проверка
 * в каждом эндпоинте обязательна и возвращает 403; эта карта управляет только
 * видимостью (`SPEC.md § 2.3`).
 */
import type { Role } from '@/api/types';

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

type PermissionMap = Readonly<Record<Permission, boolean>>;

function grant(...granted: Permission[]): PermissionMap {
  const map = Object.fromEntries(PERMISSIONS.map((key) => [key, false])) as Record<
    Permission,
    boolean
  >;
  for (const key of granted) map[key] = true;
  return map;
}

/**
 * Матрица из `SPEC.md § 2.2`.
 *
 * Роль `sales` добавлена по ТЗ 2.1 (ADR-011) и подлежит подтверждению
 * заказчиком — G-06. Пока подтверждения нет, пользователи с ней не создаются,
 * но право объявлено: добавить роль в карту сейчас стоит одну строку, после
 * написания проверок в каждом эндпоинте — правку всех эндпоинтов.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, PermissionMap>> = {
  admin: Object.fromEntries(PERMISSIONS.map((key) => [key, true])) as PermissionMap,

  dispatcher: grant(
    'schedule.view',
    'flight.create',
    'flight.edit',
    'flight.status',
    'request.approve',
    'service.order',
    'service.confirm',
    'catalog.view',
    'vendor.view',
    'vendor.assign',
    'contract.view',
    'client.view',
    'billing.documents.view',
    'billing.margin.view',
    'billing.purchase_price.view',
    'comms.view',
    'reports.operational',
    'dashboard.dispatcher',
  ),

  sales: grant(
    'schedule.view',
    'client.view',
    'tariff.view',
    'catalog.view',
    'billing.documents.view',
    'billing.documents.edit',
    'comms.view',
    'reports.financial',
  ),

  finance: grant(
    'schedule.view',
    'catalog.view',
    'catalog.edit',
    'vendor.view',
    'contract.view',
    'contract.edit',
    'client.view',
    'client.edit',
    'tariff.view',
    'tariff.edit',
    'billing.documents.view',
    'billing.documents.edit',
    'billing.payables.view',
    'billing.payables.edit',
    'billing.reconciliation',
    'billing.margin.view',
    'billing.purchase_price.view',
    'comms.view',
    'reports.financial',
  ),

  manager: grant(
    'schedule.view',
    'catalog.view',
    'vendor.view',
    'contract.view',
    'client.view',
    'tariff.view',
    'billing.documents.view',
    'billing.payables.view',
    'billing.margin.view',
    'billing.purchase_price.view',
    'comms.view',
    'reports.operational',
    'reports.financial',
    'dashboard.dispatcher',
    'dashboard.manager',
    'audit.view',
  ),

  // Портал клиента: свои рейсы и свои документы. Закупочных цен и данных
  // поставщиков нет по построению ответа, а не по фильтрации на клиенте.
  client: grant('schedule.view', 'flight.request', 'billing.documents.view'),

  // Портал поставщика: только свои заявки и свои показатели.
  vendor: grant('service.confirm.own', 'billing.payables.view', 'reports.vendor.own'),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role][permission];
}
