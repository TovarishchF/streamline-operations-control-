import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки администрирования `[ТЗ 4.3, этап 2]`.
 *
 * Заведение пользователя и управление демонстрационным набором. Проверяется
 * работа за кнопкой: пользователь появляется на сервере, а генерация
 * отчитывается тем, что создала.
 *
 * Очистка и пересоздание здесь **не нажимаются**: они уносят со стенда всё,
 * на чём работают остальные испытания. Их поведение проверено тестами
 * сервера, включая запрет в боевом режиме и сохранность настоящих записей.
 */

/** Суффикс прогона: логин уникален, повторный запуск не должен падать на себе. */
const RUN = Date.now().toString(36).slice(-6).toLowerCase();

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

async function pickOption(
  scope: Locator,
  page: Page,
  label: string,
  option: string,
): Promise<void> {
  await scope
    .locator('.ant-form-item')
    .filter({ hasText: label })
    .locator('.ant-select-selector')
    .first()
    .click();
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .last()
    .locator('.ant-select-item-option', { hasText: option })
    .first()
    .click();
}

test.describe('Администрирование', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_admin');
  });

  test('кнопка «Добавить пользователя» заводит учётную запись', async ({ page }) => {
    const email = `proba.${RUN}@example.test`;
    await page.goto('/admin/users', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    const form = dialog(page);
    await form.getByLabel('Имя').fill(`Проба Пользователь ${RUN.toUpperCase()}`);
    await form.getByLabel('Почта').fill(email);

    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/users') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Создать' }).click();

    const response = await created;
    expect(response.status(), 'сервер отказал в заведении').toBe(201);
    expect(((await response.json()) as { email: string }).email).toBe(email);

    await expect(form).toBeHidden();
    // Запись на сервере, а не в состоянии вкладки
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(email)).toBeVisible();
  });

  test('роль портала требует контрагента', async ({ page }) => {
    await page.goto('/admin/users', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    const form = dialog(page);
    await form.getByLabel('Имя').fill('Проба Портал');
    await form.getByLabel('Почта').fill(`portal.${RUN}@example.test`);
    await pickOption(form, page, 'Роль', 'Клиент');

    // Поле контрагента появилось и обязательно: портал без клиента
    // показал бы пустой экран.
    await expect(form.getByLabel('Клиент')).toBeVisible();
    await form.getByRole('button', { name: 'Создать' }).click();
    await expect(form.locator('.ant-form-item-explain-error').first()).toBeVisible();
  });

  test('кнопка «Сгенерировать» отчитывается тем, что создала', async ({ page }) => {
    await page.goto('/admin/demo-data', { waitUntil: 'networkidle' });

    const generated = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/demo/seed') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Сгенерировать' }).click();

    const response = await generated;
    expect(response.status(), 'сервер отказал в генерации').toBe(200);

    const body = (await response.json()) as {
      action: string;
      counts: Record<string, number>;
    };
    expect(body.action).toBe('seed');
    expect(Object.keys(body.counts).length).toBeGreaterThan(0);

    // Числа видны на экране, а не только вернулись в ответе
    await expect(page.locator('.ant-alert-success')).toBeVisible();
  });

  test('очистка и пересоздание спрашивают подтверждение', async ({ page }) => {
    await page.goto('/admin/demo-data', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Очистить демо-записи' }).click();
    const confirmation = page.locator('.ant-modal-confirm');
    await expect(confirmation).toBeVisible();
    // Подтверждение говорит, что именно останется
    await expect(confirmation.getByText('журнал действий остаются')).toBeVisible();

    // Отказываемся: стенд нужен остальным испытаниям
    await confirmation.getByRole('button', { name: 'Отмена' }).click();
    await expect(confirmation).toBeHidden();
  });
});
