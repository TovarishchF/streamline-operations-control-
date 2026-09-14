import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки заведения записей в реестрах и справочниках.
 *
 * Проверяется не то, что модальное окно открылось, а то, что после нажатия
 * «Создать» запись появилась **на сервере** и видна в таблице. Открывшаяся
 * форма, которая ничего не сохраняет, — ровно та беда, ради которой
 * эти испытания и написаны.
 *
 * Каждый прогон использует свой суффикс: наименования контрагентов
 * уникальны, и повторный запуск по тем же данным должен получать отказ
 * от сервера, а не молча создавать дубль.
 */

const RUN = Date.now().toString(36).slice(-5).toUpperCase();

/** Выбор значения в списке Ant Design. */
async function pickOption(page: Page, select: Locator, search?: string): Promise<void> {
  await select.click();
  if (search !== undefined) {
    await page.keyboard.type(search);
    // Поиск по справочнику идёт на сервере: список перерисовывается ответом.
    await page.waitForTimeout(600);
  }
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option').first().click();
}

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

async function submit(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Создать' }).click();
}

test.describe('Реестры и справочники', () => {
  test.beforeEach(async ({ page }) => {
    // Администратор: у него есть все права из матрицы SPEC § 2.2,
    // а разграничение доступа проверяется отдельными тестами на сервере.
    await signInAs(page, 'usr_admin');
  });

  test('кнопка «Добавить клиента» заводит клиента', async ({ page }) => {
    const name = `Проба Клиент ${RUN}`;
    await page.goto('/clients', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить клиента' }).click();
    const form = dialog(page);
    await form.getByLabel('Клиент', { exact: true }).fill(name);
    await form.getByLabel('Юридическое наименование').fill(`ООО «Проба ${RUN}»`);
    await submit(page);

    await expect(form).toBeHidden();
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  test('кнопка «Добавить поставщика» заводит поставщика', async ({ page }) => {
    const name = `Проба Поставщик ${RUN}`;
    await page.goto('/vendors', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить поставщика' }).click();
    const form = dialog(page);
    await form.getByLabel('Поставщик', { exact: true }).fill(name);
    await form.getByLabel('Юридическое наименование').fill(`ООО «Проба ${RUN}»`);
    await pickOption(page, form.getByLabel('Специализации'));
    await page.keyboard.press('Escape');
    await submit(page);

    await expect(form).toBeHidden();
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  test('кнопка «Добавить аэропорт» заводит площадку', async ({ page }) => {
    // Код ИКАО из диапазона, не занятого настоящими аэропортами.
    const icao = `ZZ${RUN.slice(0, 2)}`;
    await page.goto('/airports', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить аэропорт' }).click();
    const form = dialog(page);
    await form.getByLabel('ICAO').fill(icao);
    await form.getByLabel('Наименование (рус.)').fill(`Проба ${RUN}`);
    await form.getByLabel('Наименование (англ.)').fill(`Probe ${RUN}`);
    await form.getByLabel('Широта').fill('55.5');
    await form.getByLabel('Долгота').fill('37.5');
    await submit(page);

    await expect(form).toBeHidden();

    await page.getByPlaceholder(/Код ИКАО|ICAO/i).first().fill(icao);
    await expect(page.getByText(icao, { exact: true }).first()).toBeVisible();
  });

  test('кнопка «Добавить ВС» ставит борт в парк', async ({ page }) => {
    const registration = `RA-${RUN}`;
    await page.goto('/fleet', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить ВС' }).click();
    const form = dialog(page);
    await form.getByLabel('Бортовой номер').fill(registration);
    await pickOption(page, form.getByLabel('Тип ВС'));
    await pickOption(page, form.getByLabel('База'), 'UUWW');
    await submit(page);

    await expect(form).toBeHidden();
    await expect(page.getByText(registration, { exact: true })).toBeVisible();
  });

  test('кнопка «Добавить услугу» добавляет позицию каталога', async ({ page }) => {
    const code = `PROBE-${RUN}`;
    await page.goto('/catalog/services', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить услугу' }).click();
    const form = dialog(page);
    await form.getByLabel('Код').fill(code);
    await pickOption(page, form.getByLabel('Категория'));
    await form.getByLabel('Наименование (рус.)').fill(`Проба ${RUN}`);
    await form.getByLabel('Наименование (англ.)').fill(`Probe ${RUN}`);
    await pickOption(page, form.getByLabel('Единица'));
    await submit(page);

    await expect(form).toBeHidden();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
  });

  test('кнопка «Добавить цену» заносит цену поставщика в прайс', async ({ page }) => {
    await page.goto('/catalog/prices', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить цену' }).first().click();
    const form = dialog(page);
    await pickOption(page, form.getByLabel('Поставщик'));
    await pickOption(page, form.getByLabel('Услуга'));
    await pickOption(page, form.getByLabel('Аэропорт'), 'UUWW');

    await form.getByLabel('Действует с').fill('01.01.2027');
    await page.keyboard.press('Enter');
    await form.getByLabel('Действует по').fill('31.12.2027');
    await page.keyboard.press('Enter');
    await form.getByLabel('Цена за единицу').fill('1234');

    await submit(page);
    await expect(form).toBeHidden();
    await expect(page.getByText('1 234,00').first()).toBeVisible();
  });

  test('кнопка «Загрузить файл» кладёт скан договора в хранилище', async ({ page }) => {
    const number = `ДГ-ПРОБА-${RUN}`;
    await page.goto('/contracts', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить договор' }).click();
    const form = dialog(page);
    await pickOption(page, form.getByLabel('Поставщик'));
    await form.getByLabel('Номер договора').fill(number);

    await form.getByLabel('Действует с').fill('01.01.2027 00:00');
    await page.keyboard.press('Enter');
    await form.getByLabel('Действует по').fill('31.12.2027 00:00');
    await page.keyboard.press('Enter');

    // Файл уходит прямо в объектное хранилище по подписанной ссылке (ADR-007).
    await form.locator('input[type="file"]').setInputFiles({
      name: `Договор ${number}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% e2e\ntrailer<<>>\n%%EOF\n'),
    });
    // Имя файла появляется только после подтверждения загрузки сервером.
    await expect(form.getByText(`Договор ${number}.pdf`)).toBeVisible({ timeout: 20_000 });

    await submit(page);
    await expect(form).toBeHidden();

    await page.getByRole('radio', { name: 'Все' }).click();
    await expect(page.getByText(number, { exact: true })).toBeVisible();
  });
});
