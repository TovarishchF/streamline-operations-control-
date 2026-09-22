/**
 * Структура навигации.
 *
 * Разделы и маршруты — по карте экранов `SPEC.md § 3`. Видимость пункта
 * определяется правом из `SPEC.md § 2.2`; пункт без доступного права не
 * показывается. Это только видимость: доступ проверяется на сервере.
 */
import type { Permission } from '@/shared/auth/permissions';

export interface NavItem {
  key: string;
  path: string;
  labelKey: string;
  permission: Permission;
  /** Пункт демонстрационного стенда: вне `DEMO_DATA=true` не выводится. */
  demoOnly?: boolean;
}

export interface NavGroup {
  key: string;
  labelKey: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'operations',
    labelKey: 'nav.groups.operations',
    items: [
      { key: 'schedule', path: '/schedule', labelKey: 'nav.schedule', permission: 'schedule.view' },
      { key: 'templates', path: '/schedule/templates', labelKey: 'nav.templates', permission: 'flight.create' },
      { key: 'requests', path: '/requests', labelKey: 'nav.requests', permission: 'request.approve' },
      { key: 'slots', path: '/slots', labelKey: 'nav.slots', permission: 'flight.edit' },
    ],
  },
  {
    key: 'reference',
    labelKey: 'nav.groups.reference',
    items: [
      { key: 'catalog', path: '/catalog/services', labelKey: 'nav.catalog', permission: 'catalog.view' },
      { key: 'prices', path: '/catalog/prices', labelKey: 'nav.prices', permission: 'catalog.view' },
      { key: 'vendors', path: '/vendors', labelKey: 'nav.vendors', permission: 'vendor.view' },
      { key: 'contracts', path: '/contracts', labelKey: 'nav.contracts', permission: 'contract.view' },
      { key: 'clients', path: '/clients', labelKey: 'nav.clients', permission: 'client.view' },
      { key: 'fleet', path: '/fleet', labelKey: 'nav.fleet', permission: 'schedule.view' },
      { key: 'airports', path: '/airports', labelKey: 'nav.airports', permission: 'catalog.view' },
    ],
  },
  {
    key: 'finance',
    labelKey: 'nav.groups.finance',
    items: [
      { key: 'quotes', path: '/billing/quotes', labelKey: 'nav.quotes', permission: 'billing.documents.view' },
      { key: 'invoices', path: '/billing/invoices', labelKey: 'nav.invoices', permission: 'billing.documents.view' },
      { key: 'payables', path: '/billing/payables', labelKey: 'nav.payables', permission: 'billing.payables.view' },
      { key: 'reconciliation', path: '/billing/reconciliation', labelKey: 'nav.reconciliation', permission: 'billing.reconciliation' },
      { key: 'fx', path: '/billing/fx', labelKey: 'nav.fx', permission: 'billing.documents.view' },
    ],
  },
  {
    key: 'comms',
    labelKey: 'nav.groups.comms',
    items: [
      { key: 'outbox', path: '/communications/outbox', labelKey: 'nav.outbox', permission: 'comms.view' },
      { key: 'inbox', path: '/communications/inbox', labelKey: 'nav.inbox', permission: 'comms.view' },
      { key: 'templates-msg', path: '/communications/templates', labelKey: 'nav.messageTemplates', permission: 'comms.templates.edit' },
    ],
  },
  {
    key: 'reports',
    labelKey: 'nav.groups.reports',
    items: [
      { key: 'reports', path: '/reports', labelKey: 'nav.reports', permission: 'reports.operational' },
      { key: 'dash-disp', path: '/dashboards/dispatcher', labelKey: 'nav.dashboardDispatcher', permission: 'dashboard.dispatcher' },
      { key: 'dash-mgr', path: '/dashboards/manager', labelKey: 'nav.dashboardManager', permission: 'dashboard.manager' },
    ],
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    items: [
      { key: 'users', path: '/admin/users', labelKey: 'nav.users', permission: 'admin' },
      { key: 'audit', path: '/admin/audit', labelKey: 'nav.audit', permission: 'audit.view' },
      { key: 'integrations', path: '/admin/integrations', labelKey: 'nav.integrations', permission: 'admin' },
      { key: 'sla', path: '/admin/sla', labelKey: 'nav.sla', permission: 'admin' },
      { key: 'performance', path: '/admin/performance', labelKey: 'nav.performance', permission: 'admin' },
      // Управление наполнением стенда. Вне `DEMO_DATA=true` сервер
      // отказывает всем трём командам, и пункт не выводится.
      { key: 'demo-data', path: '/admin/demo-data', labelKey: 'nav.demoData', permission: 'admin', demoOnly: true },
      { key: 'api-docs', path: '/api-docs', labelKey: 'nav.apiDocs', permission: 'admin' },
    ],
  },
];

/** Стартовый экран по роли: диспетчеру план, руководителю дашборд и так далее. */
export const HOME_BY_ROLE: Record<string, string> = {
  admin: '/schedule',
  dispatcher: '/dashboards/dispatcher',
  sales: '/billing/quotes',
  finance: '/billing/invoices',
  manager: '/dashboards/manager',
  client: '/portal/client/flights',
  vendor: '/portal/vendor/orders',
};
