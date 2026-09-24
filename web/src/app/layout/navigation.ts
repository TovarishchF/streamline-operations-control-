/**
 * Структура навигации.
 *
 * Разделы и маршруты — по карте экранов `SPEC.md § 3`. Видимость пункта
 * определяется правом из `SPEC.md § 2.2`; пункт без доступного права не
 * показывается. Это только **видимость**: доступ проверяется на сервере
 * в каждом эндпоинте, скрытие пункта разграничением доступа не является.
 *
 * Рельс несёт девять пунктов в трёх группах — состав задан дизайн-системой
 * «Streamline SOC» (карточка `NavRail`). Экраны, не попавшие в девятку,
 * достижимы вкладками внутри своего раздела: длинный список разделов
 * диспетчер перечитывает каждый раз, а вкладки внутри раздела — один раз.
 */
import type { Permission } from '@/shared/auth/permissions';

/** Экран внутри раздела: вкладка на странице раздела. */
export interface NavChild {
  key: string;
  path: string;
  labelKey: string;
  permission: Permission;
}

export interface NavItem {
  key: string;
  /** Куда ведёт пункт рельса — первый экран раздела. */
  path: string;
  labelKey: string;
  permission: Permission;
  /** Имя значка `@ant-design/icons` без суффикса `Outlined`. */
  icon: string;
  /** Пункт демонстрационного стенда: вне `DEMO_DATA=true` не выводится. */
  demoOnly?: boolean;
  children?: NavChild[];
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
      {
        key: 'schedule',
        path: '/schedule',
        labelKey: 'nav.schedule',
        permission: 'schedule.view',
        icon: 'Schedule',
        children: [
          { key: 'plan', path: '/schedule', labelKey: 'nav.schedule', permission: 'schedule.view' },
          {
            key: 'templates',
            path: '/schedule/templates',
            labelKey: 'nav.templates',
            permission: 'flight.create',
          },
        ],
      },
      {
        key: 'requests',
        path: '/requests',
        labelKey: 'nav.requests',
        permission: 'request.approve',
        icon: 'Inbox',
      },
      {
        key: 'slots',
        path: '/slots',
        labelKey: 'nav.slotsAndAirports',
        permission: 'flight.edit',
        icon: 'Environment',
        children: [
          { key: 'slots', path: '/slots', labelKey: 'nav.slots', permission: 'flight.edit' },
          {
            key: 'airports',
            path: '/airports',
            labelKey: 'nav.airports',
            permission: 'catalog.view',
          },
        ],
      },
      {
        key: 'comms',
        path: '/communications/outbox',
        labelKey: 'nav.messages',
        permission: 'comms.view',
        icon: 'Mail',
        children: [
          {
            key: 'outbox',
            path: '/communications/outbox',
            labelKey: 'nav.outbox',
            permission: 'comms.view',
          },
          {
            key: 'inbox',
            path: '/communications/inbox',
            labelKey: 'nav.inbox',
            permission: 'comms.view',
          },
          {
            key: 'templates',
            path: '/communications/templates',
            labelKey: 'nav.messageTemplates',
            permission: 'comms.templates.edit',
          },
        ],
      },
    ],
  },
  {
    key: 'finance',
    labelKey: 'nav.groups.finance',
    items: [
      {
        key: 'billing',
        path: '/billing/quotes',
        labelKey: 'nav.billing',
        permission: 'billing.documents.view',
        icon: 'Dollar',
        children: [
          {
            key: 'quotes',
            path: '/billing/quotes',
            labelKey: 'nav.quotes',
            permission: 'billing.documents.view',
          },
          {
            key: 'invoices',
            path: '/billing/invoices',
            labelKey: 'nav.invoices',
            permission: 'billing.documents.view',
          },
          {
            key: 'payables',
            path: '/billing/payables',
            labelKey: 'nav.payables',
            permission: 'billing.payables.view',
          },
          {
            key: 'reconciliation',
            path: '/billing/reconciliation',
            labelKey: 'nav.reconciliation',
            permission: 'billing.reconciliation',
          },
          { key: 'fx', path: '/billing/fx', labelKey: 'nav.fx', permission: 'billing.documents.view' },
        ],
      },
      {
        key: 'reports',
        path: '/reports',
        labelKey: 'nav.reportsAndMargin',
        permission: 'reports.operational',
        icon: 'BarChart',
        children: [
          { key: 'reports', path: '/reports', labelKey: 'nav.reports', permission: 'reports.operational' },
          {
            key: 'dispatcher',
            path: '/dashboards/dispatcher',
            labelKey: 'nav.dashboardDispatcher',
            permission: 'dashboard.dispatcher',
          },
          {
            key: 'manager',
            path: '/dashboards/manager',
            labelKey: 'nav.dashboardManager',
            permission: 'dashboard.manager',
          },
        ],
      },
      {
        key: 'counterparties',
        path: '/vendors',
        labelKey: 'nav.counterparties',
        permission: 'vendor.view',
        icon: 'Team',
        children: [
          { key: 'vendors', path: '/vendors', labelKey: 'nav.vendors', permission: 'vendor.view' },
          { key: 'clients', path: '/clients', labelKey: 'nav.clients', permission: 'client.view' },
          {
            key: 'contracts',
            path: '/contracts',
            labelKey: 'nav.contracts',
            permission: 'contract.view',
          },
        ],
      },
    ],
  },
  {
    key: 'system',
    labelKey: 'nav.groups.system',
    items: [
      {
        key: 'catalog',
        path: '/catalog/services',
        labelKey: 'nav.references',
        permission: 'catalog.view',
        icon: 'Book',
        children: [
          {
            key: 'services',
            path: '/catalog/services',
            labelKey: 'nav.catalog',
            permission: 'catalog.view',
          },
          {
            key: 'prices',
            path: '/catalog/prices',
            labelKey: 'nav.prices',
            permission: 'catalog.view',
          },
          { key: 'fleet', path: '/fleet', labelKey: 'nav.fleet', permission: 'schedule.view' },
        ],
      },
      {
        key: 'integrations',
        path: '/admin/integrations',
        labelKey: 'nav.integrations',
        permission: 'admin',
        icon: 'Api',
        children: [
          {
            key: 'integrations',
            path: '/admin/integrations',
            labelKey: 'nav.integrations',
            permission: 'admin',
          },
          { key: 'users', path: '/admin/users', labelKey: 'nav.users', permission: 'admin' },
          {
            key: 'registrations',
            path: '/admin/registrations',
            labelKey: 'nav.registrationQueue',
            permission: 'admin',
          },
          { key: 'audit', path: '/admin/audit', labelKey: 'nav.audit', permission: 'audit.view' },
          { key: 'sla', path: '/admin/sla', labelKey: 'nav.sla', permission: 'admin' },
          {
            key: 'performance',
            path: '/admin/performance',
            labelKey: 'nav.performance',
            permission: 'admin',
          },
          {
            key: 'demo-data',
            path: '/admin/demo-data',
            labelKey: 'nav.demoData',
            permission: 'admin',
          },
          { key: 'api-docs', path: '/api-docs', labelKey: 'nav.apiDocs', permission: 'admin' },
        ],
      },
    ],
  },
];

/** Все экраны рельса и его вкладок — для подсветки и для хлебных крошек. */
export const NAV_PATHS: string[] = NAV_GROUPS.flatMap((group) =>
  group.items.flatMap((item) => [item.path, ...(item.children ?? []).map((child) => child.path)]),
);

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
