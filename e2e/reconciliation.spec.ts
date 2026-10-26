import { expect, test, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Сверка счетов поставщиков `[ТЗ 3.4.2]`.
 *
 * Проверяется путь финансиста целиком и на настоящем сервере: шаблон
 * скачивается, файл с ошибкой возвращается с номерами строк, правильный
 * файл импортируется и сверяется, расхождение разбирается. Экран раньше
 * показывал макет, где ни одна из этих кнопок ничего не делала.
 */

/** Номер счёта уникален у поставщика: каждому прогону — свой. */
const RUN = Date.now().toString(36).toUpperCase();

const HEADER =
  'Номер счёта;Дата счёта;Валюта;Аэропорт ИКАО;Дата услуги;Код услуги;Количество;Цена за единицу;Сумма';

async function openImport(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Импортировать счёт' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.ant-select').click();
  await page.locator('.ant-select-dropdown .ant-select-item-option').first().click();
}

async function attach(page: Page, name: string, text: string): Promise<void> {
  await page
    .getByRole('dialog')
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf-8') });
}

test.describe('Сверка счетов', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_fin');
    await page.goto('/billing/reconciliation');
    await expect(page.getByRole('heading', { name: 'Сверка счетов' })).toBeVisible();
  });

  test('шаблон скачивается с колонками, которые читает импорт', async ({ page }) => {
    await page.getByRole('button', { name: 'Импортировать счёт' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('dialog').getByText('Шаблон CSV').click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('soc-vendor-invoice-template.csv');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf-8').replace(/^﻿/, '').trim()).toBe(HEADER);
  });

  test('кнопка импорта говорит, чего не хватает', async ({ page }) => {
    // Раньше кнопка была выключена без объяснений, и казалось, что она не работает
    await page.getByRole('button', { name: 'Импортировать счёт' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Импортировать' }).click();

    await expect(dialog.locator('.ant-typography-danger')).toHaveText([
      'Выберите поставщика',
      'Выберите файл счёта',
    ]);

    // Файл не того формата не отбрасывается молча
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'счёт.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') });
    await expect(dialog).toContainText('«счёт.xls» — не XLSX и не CSV');
  });

  test('ошибки файла показываются по строкам, счёт не создаётся', async ({ page }) => {
    await openImport(page);
    await attach(page, 'bad.csv', `${HEADER}\nE2E-BAD-${RUN};20.10.2026;RUB;UUW;вчера;GPU;1;1;1\n`);
    await page.getByRole('dialog').getByRole('button', { name: 'Импортировать' }).click();

    const error = page.getByRole('dialog').locator('.ant-alert-error');
    await expect(error).toContainText('Строка 2: Аэропорт ИКАО');
    await expect(error).toContainText('Строка 2: Дата услуги');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('файл по шаблону импортируется, расхождение разбирается', async ({ page }) => {
    const number = `E2E-${RUN}`;
    await openImport(page);
    await attach(
      page,
      'invoice.csv',
      `${HEADER}\n${number};20.10.2026;RUB;UUWW;18.10.2026 14:30;E2E-CODE;2;4500,00;9000,00\n`,
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Импортировать' }).click();

    // После импорта открывается разбор этого счёта
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).toHaveURL(/\/billing\/reconciliation\/vin_/);
    await expect(page.locator('.ant-descriptions')).toContainText(number);
    // Неизвестный код поставщика попадает в очередь сопоставления (ADR-024)
    await expect(page.getByText('Неопознанных кодов поставщика: 1')).toBeVisible();

    const row = page.locator('.ant-table-row', { hasText: 'Нет у нас' }).first();
    await row.getByRole('button', { name: 'Разобрать' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Проверка сквозным тестом');
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();

    await expect(row).toContainText('Принять счёт поставщика');
    await expect(row.getByRole('button', { name: 'Разобрать' })).toHaveCount(0);
  });
});
