import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Снимки экранов руководства пользователя. Конфигурация — manuals.config.ts.
 *
 * Записи для снимков (рейс с отрицательной маржой, частично оплаченный счёт,
 * сверка с расхождениями) находятся через API, а не по номерам: набор
 * генератора строится на дату установки, и номера от установки к установке
 * разные.
 */

const OUT = resolve(process.cwd(), '../docs/manuals/img');
const PASSWORD = 'soc-vhod-2026-parol';

mkdirSync(OUT, { recursive: true });

interface Paged<T> {
  data: T[];
}

async function token(request: APIRequestContext, username: string): Promise<string> {
  const response = await request.post('/api/v1/auth/login', {
    data: { username, password: PASSWORD },
  });
  expect(response.ok(), `вход ${username}`).toBe(true);
  return ((await response.json()) as { tokens: { access: string } }).tokens.access;
}

async function api<T>(request: APIRequestContext, access: string, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#login_username').fill(username);
  await page.locator('#login_password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function shoot(page: Page, path: string, file: string): Promise<void> {
  if (path) await page.goto(path);
  await settle(page);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.ant-skeleton-active')).toHaveCount(0, { timeout: 30_000 });
  // Графики и планшет дорисовываются после ответа сервера.
  await page.waitForTimeout(1200);
}

test('экран входа', async ({ page }) => {
  await page.goto('/login');
  await shoot(page, '', 'login');
});

test('диспетчер', async ({ page, request }) => {
  const access = await token(request, 'karpov');
  const inWork = await api<Paged<{ id: string }>>(request, access, '/flights?status=in_work&perPage=50');
  const losing = await api<Paged<{ id: string }>>(
    request,
    access,
    '/flights?status=completed&marginBelowPercent=0&perPage=5',
  );
  const flight = inWork.data[0]?.id;
  const negative = losing.data[0]?.id;
  expect(flight, 'рейс в работе').toBeTruthy();
  expect(negative, 'рейс с отрицательной маржой').toBeTruthy();

  await signIn(page, 'karpov');
  await shoot(page, '/', 'dashboard-dispatcher');
  await page.goto('/schedule');
  await page.getByText('Трое суток', { exact: true }).click();
  await shoot(page, '', 'schedule-gantt');
  await page.getByText('Таблица', { exact: true }).click();
  await shoot(page, '', 'schedule-table');
  await shoot(page, `/flights/${flight}`, 'flight-overview');
  await shoot(page, `/flights/${flight}/services`, 'flight-services');
  await shoot(page, `/flights/${negative}/finance`, 'flight-finance');
  await shoot(page, '/vendors', 'vendors');
  await shoot(page, '/contracts', 'contracts');
  await shoot(page, '/catalog/prices', 'prices');
  await shoot(page, '/communications/outbox', 'outbox');
});

test('финансист', async ({ page, request }) => {
  const access = await token(request, 'gordeeva');
  const partly = await api<Paged<{ id: string }>>(request, access, '/invoices?status=partially_paid');
  const paid = await api<Paged<{ id: string }>>(request, access, '/invoices?status=paid');
  const invoice = partly.data[0]?.id ?? paid.data[0]?.id;
  expect(invoice, 'счёт с оплатой').toBeTruthy();

  type Reconciliation = { id: string; reconciliation: { discrepancies: { kind: string }[] } };
  const reconciliations = await api<Paged<Reconciliation>>(request, access, '/reconciliation?perPage=50');
  const richest = [...reconciliations.data].sort(
    (a, b) =>
      new Set(b.reconciliation.discrepancies.map((item) => item.kind)).size -
      new Set(a.reconciliation.discrepancies.map((item) => item.kind)).size,
  )[0];
  expect(richest?.reconciliation.discrepancies.length, 'сверка с расхождениями').toBeGreaterThan(0);

  await signIn(page, 'gordeeva');
  await shoot(page, '/billing/invoices', 'invoices');
  await shoot(page, `/billing/invoices/${invoice}`, 'invoice-card');
  await shoot(page, '/billing/payables', 'payables');
  await shoot(page, `/billing/reconciliation/${richest?.id}`, 'reconciliation');
});

test('руководитель', async ({ page }) => {
  await signIn(page, 'sokolov');
  await shoot(page, '/dashboards/manager', 'dashboard-manager');
  await page.goto('/reports/financial');
  await page.getByRole('button', { name: 'Построить' }).click();
  await shoot(page, '', 'report-view');
});

test('администратор', async ({ page }) => {
  await signIn(page, 'volkova');
  await shoot(page, '/admin/audit', 'audit');
  await shoot(page, '/admin/integrations', 'integrations');
});

test('портал клиента', async ({ page }) => {
  await signIn(page, 'lebedeva');
  await shoot(page, '/portal/client/flights', 'portal-client');
});

test('портал поставщика', async ({ page }) => {
  await signIn(page, 'zaharov');
  await shoot(page, '/portal/vendor/orders', 'portal-vendor');
});
