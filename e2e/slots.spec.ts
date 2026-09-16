import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки реестра слотов `[ТЗ 3.1.1, 3.2.1, 4.2]` (ADR-026).
 *
 * Подключения к слот-координации не существует, поэтому проверяется
 * поведение инструмента подготовки переписки: «Сформировать SCR» приносит
 * черновик с сервера и закрепляет номер сообщения, «Внести ответ» двигает
 * слот, «Запросить слот» заводит запись.
 *
 * Отдельно проверяется, что экран прямо говорит: сообщение отсюда
 * не отправляется (`CLAUDE.md § 4`).
 */

/** Суффикс прогона: повторный запуск не должен натыкаться на свои же данные. */
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

/** Выбор значения в открывающемся списке Ant Design. */
async function pickOption(
  scope: Locator,
  page: Page,
  label: string,
  search?: string,
): Promise<void> {
  await scope
    .locator('.ant-form-item')
    .filter({ hasText: label })
    .locator('.ant-select-selector')
    .first()
    .click();
  if (search !== undefined) {
    await page.keyboard.type(search);
    await page.waitForTimeout(600);
  }
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .last()
    .locator('.ant-select-item-option')
    .first()
    .click();
}

test.describe('Слоты', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_disp1');
    await page.goto('/slots', { waitUntil: 'networkidle' });
  });

  test('реестр приходит с сервера', async ({ page }) => {
    const listed = page.waitForResponse(
      (response) => response.url().includes('/api/v1/slots?') && response.status() === 200,
    );
    await page.reload({ waitUntil: 'networkidle' });
    const body = (await (await listed).json()) as { data: { status: string }[] };

    expect(body.data.length, 'на стенде нет слотов').toBeGreaterThan(0);
    await expect(page.locator('.ant-table-row').first()).toBeVisible();
    // Экран прямо говорит, что подключения нет
    await expect(page.getByText('Публичного интерфейса слот-координации')).toBeVisible();
  });

  test('кнопка «Сформировать SCR» приносит черновик и номер сообщения', async ({ page }) => {
    const built = page.waitForResponse(
      (response) => response.url().includes('/scr') && response.request().method() === 'POST',
    );
    await page.locator('.ant-table-row').first()
      .getByRole('button', { name: 'Сформировать SCR' }).click();

    const response = await built;
    expect(response.status(), 'сервер не собрал сообщение').toBe(200);

    const message = (await response.json()) as { messageRef: string; text: string };
    expect(message.messageRef).toMatch(/^SCR-\d{4}-\d{4}$/);
    // Сообщение собрано по структуре SSIM: тип, сезон, дата, аэропорт
    expect(message.text.split('\n')[0]).toBe('SCR');
    expect(message.text).toMatch(/\n[SW]\d{2}\n/);

    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer).toBeVisible();
    // Черновик виден и правится, а не только вернулся в ответе
    await expect(drawer.locator('textarea')).toHaveValue(message.text);
    // И сказано, что отсюда он не уходит
    await expect(drawer.getByText('не отправляется отсюда')).toBeVisible();
  });

  test('кнопка «Внести ответ» подтверждает слот', async ({ page }) => {
    const row = page
      .locator('.ant-table-row')
      .filter({ has: page.getByRole('button', { name: 'Внести ответ' }) })
      .first();
    await expect(row, 'на стенде нет слотов в ожидании ответа').toBeVisible();

    await row.getByRole('button', { name: 'Внести ответ' }).click();
    const form = dialog(page);
    await form.getByLabel('Ответ координатора').fill('SLOT CONFIRMED 1345Z');

    const applied = page.waitForResponse(
      (response) => response.url().includes('/apply') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Применить' }).click();

    const response = await applied;
    expect(response.status(), 'сервер отказал в применении').toBe(200);

    const slot = (await response.json()) as { status: string; confirmedTimeUtc: string | null };
    expect(slot.status).toBe('confirmed');
    expect(slot.confirmedTimeUtc).not.toBeNull();
  });

  test('непонятый ответ просит решение, а не молчит', async ({ page }) => {
    const row = page
      .locator('.ant-table-row')
      .filter({ has: page.getByRole('button', { name: 'Внести ответ' }) })
      .first();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Внести ответ' }).click();
    const form = dialog(page);
    await form.getByLabel('Ответ координатора').fill('Перезвоните координатору');

    const refused = page.waitForResponse(
      (response) => response.url().includes('/apply') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Применить' }).click();
    expect((await refused).status()).toBe(400);

    // Окно объясняет отказ и открывает поля решения
    await expect(form.locator('.ant-alert-warning')).toBeVisible();
    await expect(form.getByLabel('Решение')).toBeVisible();
  });

  test('кнопка «Запросить слот» заводит запись', async ({ page }) => {
    await page.getByRole('button', { name: 'Запросить слот' }).click();
    const form = dialog(page);

    await pickOption(form, page, 'Рейс');
    await pickOption(form, page, 'Аэропорт');

    // Время запроса: любая дата, лишь бы не столкнуться с прошлым прогоном
    const field = form.locator('.ant-picker input');
    await field.click();
    await field.fill(`0${(Number(RUN.charCodeAt(0)) % 9) + 1}.11.2030 09:30`);
    await page.keyboard.press('Enter');

    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/slots') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Создать' }).click();
    const response = await created;

    // Либо слот заведён, либо сервер обоснованно отказал: на этот рейс
    // и движение слот уже есть. Оба исхода — работа кнопки, а не простой.
    expect([201, 400]).toContain(response.status());
    if (response.status() === 400) {
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
      return;
    }

    await expect(form).toBeHidden();
    const slot = (await response.json()) as { status: string };
    expect(slot.status).toBe('requested');
  });
});
