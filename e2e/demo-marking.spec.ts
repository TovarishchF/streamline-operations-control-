import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS, anyFlightId, signInAs } from './helpers/session';

/**
 * Пометки демонстрационного стенда `[SPEC § 8.6]`.
 *
 * Маркировка включается **только** `DEMO_DATA` на сервере: признак приходит
 * в `/auth/me` как `demoMode`, клиент своей константы не держит. Испытание
 * проверяет фактическое состояние стенда — то, что увидит человек, открывший
 * браузер, а не то, что записано в настройках.
 */

const API = process.env['SOC_API_URL'] ?? 'http://localhost:8000/api/v1';

/** Режим по ответу сервера: без него испытание проверяло бы вёрстку, а не стенд. */
async function serverDemoMode(page: Page): Promise<boolean> {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: ACCOUNTS['usr_disp1'], password: 'demo-stand-2026-parol' },
  });
  expect(login.ok()).toBeTruthy();
  const tokens = (await login.json()) as { tokens?: { access: string } };
  expect(tokens.tokens).toBeTruthy();

  const me = await page.request.get(`${API}/auth/me`, {
    headers: { Authorization: `Bearer ${tokens.tokens?.access ?? ''}` },
  });
  expect(me.ok()).toBeTruthy();
  return ((await me.json()) as { demoMode?: boolean }).demoMode ?? false;
}

test.describe('пометки стенда', () => {
  test('сервер объявляет боевой режим', async ({ page }) => {
    expect(await serverDemoMode(page)).toBe(false);
  });

  test('в шапке нет ни значка стенда, ни панели модельного времени', async ({ page }) => {
    await signInAs(page, 'usr_admin');
    await page.goto('/schedule');
    await expect(page.getByRole('heading').first()).toBeVisible();

    const header = page.locator('header').first();
    await expect(header.getByText('ДЕМО', { exact: true })).toHaveCount(0);
    await expect(header.getByText('DEMO', { exact: true })).toHaveCount(0);
    await expect(header.locator('.anticon-clock-circle')).toHaveCount(0);
    await expect(page.getByText(/синтетическ/i)).toHaveCount(0);
  });

  test('карточка рейса без подписи источника данных', async ({ page }) => {
    await signInAs(page, 'usr_disp1');
    const id = await anyFlightId(page);
    await page.goto(`/flights/${id}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await expect(page.getByText('Источник данных')).toHaveCount(0);
    await expect(page.getByText(/синтетическ/i)).toHaveCount(0);
  });

  test('раздел демо-данных в навигации не выводится', async ({ page }) => {
    await signInAs(page, 'usr_admin');
    await page.goto('/schedule');
    await expect(page.getByRole('heading').first()).toBeVisible();

    await expect(page.getByRole('link', { name: /Демо-данные/i })).toHaveCount(0);
  });
});
