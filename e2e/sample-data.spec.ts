import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS, PASSWORD, anyFlightId, signInAs } from './helpers/session';

/**
 * Режим генератора данных (ADR-008).
 *
 * Данные генератора выглядят как рабочие: ни в шапке, ни в карточках, ни
 * в меню нет пометок режима. Режим влияет только на доступ
 * к генератору и к управлению модельным временем — и это определяет сервер:
 * признак приходит в `/auth/me` как `sampleData`, клиент своей константы
 * не держит. Испытание не зависит от режима окружения: ожидания берутся
 * из ответа сервера.
 */

const API = process.env['SOC_API_URL'] ?? 'http://localhost:8000/api/v1';

/** Режим по ответу сервера: без него испытание проверяло бы вёрстку, а не систему. */
async function serverSampleData(page: Page): Promise<boolean> {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: ACCOUNTS['usr_disp1'], password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const tokens = (await login.json()) as { tokens?: { access: string } };
  expect(tokens.tokens).toBeTruthy();

  const me = await page.request.get(`${API}/auth/me`, {
    headers: { Authorization: `Bearer ${tokens.tokens?.access ?? ''}` },
  });
  expect(me.ok()).toBeTruthy();
  return ((await me.json()) as { sampleData?: boolean }).sampleData ?? false;
}

const MARKS = /демо|demo|демонстрац|синтетическ/i;

test.describe('генератор данных', () => {
  test('в шапке нет пометок режима', async ({ page }) => {
    await signInAs(page, 'usr_admin');
    await page.goto('/schedule');
    await expect(page.getByRole('heading').first()).toBeVisible();

    await expect(page.locator('header').first().getByText(MARKS)).toHaveCount(0);
  });

  test('карточка рейса без подписи источника данных', async ({ page }) => {
    await signInAs(page, 'usr_disp1');
    const id = await anyFlightId(page);
    await page.goto(`/flights/${id}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await expect(page.getByText('Источник данных')).toHaveCount(0);
    await expect(page.getByText(MARKS)).toHaveCount(0);
  });

  test('пункт генератора в меню — только в режиме генератора', async ({ page }) => {
    const enabled = await serverSampleData(page);
    await signInAs(page, 'usr_admin');
    // Экран того же раздела: подпункты раздела раскрыты.
    await page.goto('/admin/users');
    await expect(page.getByRole('heading').first()).toBeVisible();

    const entry = page.getByRole('link', { name: 'Генератор данных' });
    await expect(entry).toHaveCount(enabled ? 1 : 0);
    await expect(page.getByRole('navigation').getByText(MARKS)).toHaveCount(0);
  });
});
