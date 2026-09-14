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

/**
 * Суффикс прогона — только латинские буквы.
 *
 * Из него собирается код ИКАО, а тот по стандарту состоит из букв:
 * суффикс с цифрой давал бы отказ формы, и испытание падало бы
 * на собственных данных, а не на поведении приложения.
 */
const RUN = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (digit) => 'ABCDEFGHIJ'[Number(digit)] as string)
  .slice(-5)
  .toUpperCase();

/**
 * Год периода действия цены, свой на каждый прогон.
 *
 * Периоды по одной тройке (поставщик, услуга, аэропорт) не пересекаются —
 * это проверяет сервер. Повторный прогон с тем же периодом получил бы
 * законный отказ, и испытание падало бы на собственных данных вместо
 * поведения приложения.
 */
const PRICE_YEAR = 2030 + (Date.now() % 40);

/**
 * Выбор значения в открывающемся списке Ant Design.
 *
 * Закрывающийся список остаётся в DOM ещё несколько кадров, поэтому
 * берётся последний видимый, а не первый попавшийся.
 */
async function pickOption(page: Page, select: Locator, search?: string): Promise<void> {
  await select.click();
  if (search !== undefined) {
    await page.keyboard.type(search);
    // Поиск по справочнику идёт на сервере: список перерисовывается ответом.
    await page.waitForTimeout(800);
  }
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option').first().click();
}

/** Закрывает открытый список, не трогая модальное окно. */
async function closeDropdown(page: Page): Promise<void> {
  await page.locator('.ant-modal-header').click();
}

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

/** Заполнение поля даты: значение принимается нажатием Enter. */
async function fillDate(page: Page, field: Locator, value: string): Promise<void> {
  await field.click();
  await field.fill(value);
  await page.keyboard.press('Enter');
}

async function submit(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Создать' }).click();
}

/** Отказ формы виден как текст ошибки — его и показываем в диагностике. */
async function expectSaved(page: Page): Promise<void> {
  const form = dialog(page);
  const problems = await form
    .locator('.ant-form-item-explain-error, .ant-alert-error')
    .allTextContents();
  expect(problems, `форма не сохранилась: ${problems.join(' | ')}`).toEqual([]);
  await expect(form).toBeHidden();
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

    await expectSaved(page);
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  test('кнопка «Добавить поставщика» заводит поставщика', async ({ page }) => {
    const name = `Проба Поставщик ${RUN}`;
    await page.goto('/vendors', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить поставщика' }).click();
    const form = dialog(page);
    await form.getByLabel('Поставщик', { exact: true }).fill(name);
    await form.getByLabel('Юридическое наименование').fill(`ООО «Проба ${RUN}»`);
    await pickOption(page, form.getByLabel('Специализация'));
    await closeDropdown(page);
    await submit(page);

    await expectSaved(page);
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  test('кнопка «Добавить аэропорт» заводит площадку', async ({ page }) => {
    // Код из диапазона, не занятого настоящими аэропортами.
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

    await expectSaved(page);

    await page.getByPlaceholder('ICAO, IATA, город или название').fill(icao);
    await expect(page.getByText(icao, { exact: true }).first()).toBeVisible();
  });

  test('кнопка «Добавить ВС» ставит борт в парк', async ({ page }) => {
    const registration = `RA-${RUN}`;
    await page.goto('/fleet', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить ВС' }).click();
    const form = dialog(page);
    await form.getByLabel('Бортовой номер').fill(registration);
    await pickOption(page, form.getByLabel('Тип ВС'));
    await pickOption(page, form.getByLabel('Базовый аэропорт'), 'UUWW');
    await submit(page);

    await expectSaved(page);
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
    await pickOption(page, form.getByLabel('Ед. изм.'));
    await submit(page);

    await expectSaved(page);
    await expect(page.getByText(code, { exact: true })).toBeVisible();
  });

  test('кнопка «Добавить цену» заносит цену поставщика в прайс', async ({ page }) => {
    await page.goto('/catalog/prices', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить цену' }).first().click();
    const form = dialog(page);
    await pickOption(page, form.getByLabel('Поставщик'));
    await pickOption(page, form.getByLabel('Услуга'));
    await pickOption(page, form.getByLabel('Аэропорт'), 'UUWW');

    await fillDate(page, form.getByLabel('Действует с'), `01.01.${String(PRICE_YEAR)}`);
    await fillDate(page, form.getByLabel('Действует по'), `31.12.${String(PRICE_YEAR)}`);
    await form.getByLabel('Цена за единицу').fill('1234');

    await submit(page);
    await expectSaved(page);
    await expect(page.getByText('1 234,00').first()).toBeVisible();
  });

  test('кнопка «Загрузить файл» кладёт скан договора в хранилище', async ({ page }) => {
    const number = `ДГ-ПРОБА-${RUN}`;
    await page.goto('/contracts', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить договор' }).click();
    const form = dialog(page);
    await pickOption(page, form.getByLabel('Поставщик'));
    await form.getByLabel('Номер договора').fill(number);

    await fillDate(page, form.getByLabel('Действует с'), `01.01.${String(PRICE_YEAR)} 00:00`);
    await fillDate(page, form.getByLabel('Действует до'), `31.12.${String(PRICE_YEAR)} 00:00`);

    // Файл уходит прямо в объектное хранилище по подписанной ссылке (ADR-007).
    await form.locator('input[type="file"]').setInputFiles({
      name: `Договор ${number}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% e2e\ntrailer<<>>\n%%EOF\n'),
    });
    // Имя файла появляется только после подтверждения загрузки сервером.
    await expect(form.getByText(`Договор ${number}.pdf`)).toBeVisible({ timeout: 20_000 });

    await submit(page);
    await expectSaved(page);

    // Фильтр по умолчанию — «требуют внимания»; только что заведённый
    // договор действует, поэтому переключаемся на полный реестр.
    await page.locator('.ant-segmented-item', { hasText: 'Все' }).click();
    await expect(page.getByText(number, { exact: true })).toBeVisible();

    // Скан действительно приложен к договору, а не просто загружен
    await expect(
      page.getByRole('link', { name: `Договор ${number}.pdf` }),
    ).toBeVisible();
  });
});
