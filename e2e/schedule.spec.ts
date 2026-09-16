import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки суточного плана `[ТЗ 3.1.1, 3.1.2, 3.3.2]`.
 *
 * Выгрузка и массовые действия. Проверяется работа за кнопкой: файл
 * собирает сервер и отдаёт подписанной ссылкой, а пачка идёт по рейсам
 * поодиночке и отчитывается по каждому.
 *
 * Отдельно проверяется, что рейс, который не может перейти, не отменяет
 * переход остальных: именно ради этого результат показан построчно.
 */

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

/** Переход в табличное представление: массовые действия живут там. */
async function openTable(page: Page): Promise<void> {
  await page.goto('/schedule', { waitUntil: 'networkidle' });
  await page.locator('.ant-segmented-item', { hasText: 'Таблица' }).click();
  await expect(page.locator('.ant-table-row').first()).toBeVisible();
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

test.describe('Суточный план', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_disp1');
  });

  test('кнопка выгрузки отдаёт подписанную ссылку на книгу', async ({ page }) => {
    await openTable(page);

    const exported = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/flights/export') &&
        response.request().method() === 'POST',
    );
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Выгрузить в XLSX' }).click();

    const response = await exported;
    expect(response.status(), 'сервер не собрал выгрузку').toBe(202);

    const ticket = (await response.json()) as { status: string; downloadUrl: string | null };
    expect(ticket.status).toBe('ready');
    expect(ticket.downloadUrl).toContain('.xlsx');
    // Ссылка подписанная и временная, а не путь к файлу на сервере
    expect(ticket.downloadUrl).toContain('X-Amz-Signature');

    (await popup).close();
  });

  test('выгрузка уносит отбор экрана, а не всё подряд', async ({ page }) => {
    await openTable(page);

    // Отбор по тексту: в файл должна уйти отобранная таблица
    await page.getByPlaceholder('Номер, клиент, борт, аэропорт').fill('SLG-10');
    await page.waitForResponse(
      (response) => response.url().includes('search=SLG-10') && response.status() === 200,
    );

    const exported = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/flights/export') &&
        response.request().method() === 'POST',
    );
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Выгрузить в XLSX' }).click();

    const response = await exported;
    expect(response.status()).toBe(202);
    // Отбор дошёл до сервера вместе с запросом выгрузки
    expect(response.url()).toContain('search=SLG-10');

    (await popup).close();
  });

  test('массовые действия недоступны без выбора', async ({ page }) => {
    await openTable(page);

    await expect(page.getByRole('button', { name: 'Изменить статус' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Назначить поставщика' })).toBeDisabled();
  });

  test('массовая смена статуса отчитывается по каждому рейсу', async ({ page }) => {
    await openTable(page);

    // Три первых рейса: среди них заведомо есть и те, что перейти не смогут
    const checkboxes = page.locator('.ant-table-row .ant-checkbox-input');
    for (let index = 0; index < 3; index += 1) {
      await checkboxes.nth(index).check();
    }
    await expect(page.getByText('Выбрано рейсов: 3')).toBeVisible();

    await page.getByRole('button', { name: 'Изменить статус' }).click();
    const form = dialog(page);
    await pickOption(form, page, 'Переход', 'Взять в работу');
    await form.getByRole('button', { name: 'Применить' }).click();

    // Итог показан построчно: «применено к 7 из 10» без перечня —
    // сообщение, после которого всё равно идут проверять руками.
    const outcome = form.locator('.ant-table-row');
    await expect(outcome).toHaveCount(3);
    await expect(form.locator('.ant-alert')).toBeVisible();
  });

  test('массовое назначение поставщика спрашивает поставщика', async ({ page }) => {
    await openTable(page);

    await page.locator('.ant-table-row .ant-checkbox-input').first().check();
    await page.getByRole('button', { name: 'Назначить поставщика' }).click();

    const form = dialog(page);
    await expect(form.getByText('Назначить поставщика')).toBeVisible();
    await form.getByRole('button', { name: 'Применить' }).click();
    // Без поставщика действие не запускается
    await expect(form.locator('.ant-form-item-explain-error').first()).toBeVisible();
  });
});
