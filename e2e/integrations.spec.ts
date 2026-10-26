import { expect, test } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Внешние подключения `[ТЗ 4.2]` (ADR-039).
 *
 * На экране — только работающие подключения, без режима, доли ошибок
 * и «что нужно для боевого режима»: заглушек нет, выключенное подключение
 * система не вызывает. «Проверить» обращается к настоящей системе, и
 * результат попадает в журнал обменов.
 */
test.describe('Подключения', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_admin');
    await page.goto('/admin/integrations');
    await expect(page.locator('.ant-table-row').first()).toBeVisible();
  });

  test('показаны только работающие подключения', async ({ page }) => {
    const header = page.locator('.ant-table-thead').first();
    for (const removed of ['Режим', 'Ошибок', 'Что нужно для боевого режима']) {
      await expect(header).not.toContainText(removed);
    }
    await expect(page.getByText('stub', { exact: true })).toHaveCount(0);

    const codes = await page.locator('.ant-table-row td:first-child').allInnerTexts();
    expect(codes.map((code) => code.trim())).toEqual(['FX', 'SMTP']);
  });

  test('проверка обращается к системе и пишется в журнал', async ({ page }) => {
    const checked = page.waitForResponse(
      (response) => response.url().includes('/integrations/SMTP/test'),
    );
    await page
      .locator('.ant-table-row', { hasText: 'SMTP' })
      .getByRole('button', { name: 'Проверить' })
      .click();
    const result = (await (await checked).json()) as { success: boolean };
    // В dev SMTP — Mailpit: подключение настоящее и обязано отвечать
    expect(result.success).toBe(true);
    await expect(page.getByText('SMTP: подключение работает')).toBeVisible();

    await page.getByRole('tab', { name: 'Журнал обменов' }).click();
    await expect(
      page.locator('.ant-table-row', { hasText: 'check' }).filter({ hasText: 'SMTP' }).first(),
    ).toBeVisible();
  });
});
