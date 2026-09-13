import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Съёмка макетов вехи M2 и проверка, что экраны отрисовываются без ошибок.
 *
 * Скриншоты складываются в `artifacts/screenshots/m2/` — приёмочный критерий
 * `TASKS.md` M2 п. 4. Заодно это первая настоящая проверка, что каждый экран
 * из `SPEC.md § 3` существует и открывается: снимок экрана, который не
 * отрисовался, сделать нельзя.
 *
 * Ошибки консоли не игнорируются: приёмка M10 требует их отсутствия,
 * и начинать соблюдать это правило с M2 дешевле, чем чинить потом.
 */

const OUT = resolve(process.cwd(), '../artifacts/screenshots/m2');

/** Экраны внутреннего интерфейса. Роль подбирается так, чтобы экран был доступен. */
const INTERNAL_SCREENS: Array<{ name: string; path: string; role?: string }> = [
  { name: '01-schedule-gantt', path: '/schedule' },
  { name: '02-flight-card', path: '/flights/flt_002' },
  { name: '03-flight-services', path: '/flights/flt_002/services' },
  { name: '04-flight-finance', path: '/flights/flt_002/finance' },
  { name: '05-flight-documents', path: '/flights/flt_002/documents' },
  { name: '06-flight-history', path: '/flights/flt_002/history' },
  { name: '07-flight-new', path: '/flights/new' },
  { name: '08-templates', path: '/schedule/templates' },
  { name: '09-requests', path: '/requests' },
  { name: '10-slots', path: '/slots' },
  { name: '11-catalog-services', path: '/catalog/services' },
  { name: '12-catalog-prices', path: '/catalog/prices' },
  { name: '13-vendors', path: '/vendors' },
  { name: '14-vendor-card', path: '/vendors/ven_003' },
  { name: '15-contracts', path: '/contracts' },
  { name: '16-clients', path: '/clients' },
  { name: '17-client-tariffs', path: '/clients/cli_001' },
  { name: '18-fleet', path: '/fleet' },
  { name: '19-airports', path: '/airports' },
  { name: '20-quotes', path: '/billing/quotes', role: 'usr_fin' },
  { name: '21-quote-card', path: '/billing/quotes/qt_002', role: 'usr_fin' },
  { name: '22-invoices', path: '/billing/invoices', role: 'usr_fin' },
  { name: '23-invoice-card', path: '/billing/invoices/inv_001', role: 'usr_fin' },
  { name: '24-payables', path: '/billing/payables', role: 'usr_fin' },
  { name: '25-reconciliation', path: '/billing/reconciliation', role: 'usr_fin' },
  { name: '26-fx', path: '/billing/fx', role: 'usr_fin' },
  { name: '27-outbox', path: '/communications/outbox' },
  { name: '28-inbox', path: '/communications/inbox' },
  { name: '29-message-templates', path: '/communications/templates', role: 'usr_admin' },
  { name: '30-reports', path: '/reports' },
  { name: '31-report-financial', path: '/reports/financial', role: 'usr_fin' },
  { name: '32-dashboard-dispatcher', path: '/dashboards/dispatcher' },
  { name: '33-dashboard-manager', path: '/dashboards/manager', role: 'usr_mgr' },
  { name: '34-admin-users', path: '/admin/users', role: 'usr_admin' },
  { name: '35-admin-audit', path: '/admin/audit', role: 'usr_admin' },
  { name: '36-admin-integrations', path: '/admin/integrations', role: 'usr_admin' },
  { name: '37-admin-sla', path: '/admin/sla', role: 'usr_admin' },
  { name: '38-admin-performance', path: '/admin/performance', role: 'usr_admin' },
  { name: '39-admin-demo-data', path: '/admin/demo-data', role: 'usr_admin' },
  { name: '40-api-docs', path: '/api-docs', role: 'usr_admin' },
];

const PORTAL_SCREENS: Array<{ name: string; path: string; role: string }> = [
  { name: '41-portal-client-flights', path: '/portal/client/flights', role: 'usr_client' },
  { name: '42-portal-client-request', path: '/portal/client/request', role: 'usr_client' },
  { name: '43-portal-client-documents', path: '/portal/client/documents', role: 'usr_client' },
  { name: '44-portal-vendor-orders', path: '/portal/vendor/orders', role: 'usr_vendor' },
  { name: '45-portal-vendor-performance', path: '/portal/vendor/performance', role: 'usr_vendor' },
  { name: '46-portal-vendor-payables', path: '/portal/vendor/payables', role: 'usr_vendor' },
];

const DEMO_USERS: Record<string, { id: string; name: string; role: string; clientId?: string; vendorId?: string }> = {
  usr_admin: { id: 'usr_admin', name: 'Волкова Анна', role: 'admin' },
  usr_disp1: { id: 'usr_disp1', name: 'Карпов Илья', role: 'dispatcher' },
  usr_fin: { id: 'usr_fin', name: 'Зайцева Ольга', role: 'finance' },
  usr_mgr: { id: 'usr_mgr', name: 'Соколов Виктор', role: 'manager' },
  usr_client: { id: 'usr_client', name: 'Нечаев Роман', role: 'client', clientId: 'cli_001' },
  usr_vendor: { id: 'usr_vendor', name: 'Громов Сергей', role: 'vendor', vendorId: 'ven_003' },
};

/** Шум сторонних библиотек, не относящийся к нашему коду. */
function isRelevantError(message: ConsoleMessage): boolean {
  if (message.type() !== 'error') return false;
  const text = message.text();
  // React предупреждает о совместимости antd v5 с React 19 — не наш дефект
  if (text.includes('[antd: compatible]')) return false;
  return true;
}

async function setRole(page: Page, roleId: string): Promise<void> {
  const user = DEMO_USERS[roleId] ?? DEMO_USERS['usr_disp1'];
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('soc.session', value);
  }, JSON.stringify({ state: { user }, version: 0 }));
}

mkdirSync(OUT, { recursive: true });

test.describe('Макеты вехи M2', () => {
  for (const screen of [...INTERNAL_SCREENS, ...PORTAL_SCREENS]) {
    test(screen.name, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (isRelevantError(message)) errors.push(message.text());
      });
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });

      await setRole(page, screen.role ?? 'usr_disp1');
      await page.goto(screen.path, { waitUntil: 'networkidle' });

      // Экран считается открывшимся, когда появился основной контейнер
      await expect(page.locator('.ant-layout').first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);

      const file = `${OUT}/${testInfo.project.name}/${screen.name}.png`;
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: true });

      expect(errors, `ошибки консоли на ${screen.path}:\n${errors.join('\n')}`).toEqual([]);

      // Адаптив от 360 px: горизонтального скролла быть не должно
      if (testInfo.project.name === 'mobile') {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `горизонтальный скролл ${String(overflow)} px на ${screen.path}`).toBeLessThanOrEqual(2);
      }
    });
  }
});
