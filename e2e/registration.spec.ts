import { expect, test } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Регистрация заказчика и поставщика `[ТЗ 4.3]` (ADR-037).
 *
 * Проверяется работа за кнопкой, а не наличие полей: заявка должна
 * оказаться на сервере, а поставщик — в очереди у руководителя.
 */

const RUN = Date.now().toString(36).slice(-6).toLowerCase();

test('заказчик подаёт заявку и получает указание проверить почту', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Я — заказчик')).toBeVisible();

  await dialog.getByLabel('Название организации').fill(`Чартер ${RUN}`);
  await dialog.getByLabel('Имя', { exact: true }).fill('Мария Соболева');
  await dialog.getByLabel('Электронная почта').fill(`client-${RUN}@example.test`);
  await dialog.getByLabel('Пароль').fill('Registracia-Parol-2026');
  await dialog.getByRole('button', { name: 'Зарегистрироваться' }).click();

  await expect(dialog.getByText('Проверьте почту')).toBeVisible({ timeout: 15_000 });
});

test('поставщик заполняет категории и уходит на согласование', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await dialog.getByText('Я — поставщик').click();
  await expect(dialog.getByText(/уходит на согласование/)).toBeVisible();

  await dialog.getByLabel('Название организации').fill(`Хандлинг ${RUN}`);

  // Категории — обязательны: без них решение о поставщике принять нельзя.
  await dialog.locator('.ant-form-item').filter({ hasText: 'Категории услуг' })
    .locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .locator('.ant-select-item-option', { hasText: 'Наземное обслуживание' }).first().click();
  await page.keyboard.press('Escape');

  await dialog.getByLabel('Имя', { exact: true }).fill('Пётр Лавров');
  await dialog.getByLabel('Электронная почта').fill(`vendor-${RUN}@example.test`);
  await dialog.getByLabel('Пароль').fill('Registracia-Parol-2026');
  await dialog.getByRole('button', { name: 'Отправить заявку' }).click();

  await expect(dialog.getByText('Проверьте почту')).toBeVisible({ timeout: 15_000 });
});

test('руководитель видит очередь заявок', async ({ page }) => {
  await signInAs(page, 'usr_admin');
  await page.goto('/admin/registrations');

  await expect(page.getByRole('heading', { name: 'Заявки поставщиков' })).toBeVisible();
});
