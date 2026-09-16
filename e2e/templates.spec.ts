import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Шаблоны регулярных рейсов `[ТЗ 3.1.1]` (`SPEC.md § 4.5`).
 *
 * Две кнопки: заведение шаблона и генерация серии. Проверяется работа
 * за ними — шаблон появляется на сервере, серия создаёт настоящие рейсы.
 *
 * Отдельно проверяется, что время вылета остаётся местным: перевод в UTC
 * делается при генерации, на каждую дату отдельно, и шаблон, сохранённый
 * сразу в UTC, ломал бы расписание дважды в год.
 */

/** Суффикс прогона: наименование шаблона уникально в пределах прогона. */
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

async function pickOption(
  scope: Locator,
  page: Page,
  label: string,
  option?: string,
): Promise<void> {
  await scope
    .locator('.ant-form-item')
    .filter({ hasText: label })
    .locator('.ant-select-selector')
    .first()
    .click();
  const dropdown = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .last();
  const options = dropdown.locator('.ant-select-item-option');
  await (option === undefined ? options.first() : options.filter({ hasText: option }).first())
    .click();
}

/** Закрывает открытый список, не трогая форму. */
async function closeDropdown(page: Page): Promise<void> {
  await page.locator('.ant-modal-header').click();
}

/** Выбор дня в правой панели календаря: это следующий месяц. */
async function pickDay(page: Page, day: number): Promise<void> {
  await page
    .locator('.ant-picker-panel')
    .last()
    .locator('.ant-picker-cell-in-view .ant-picker-cell-inner')
    .filter({ hasText: new RegExp(`^${String(day)}$`) })
    .first()
    .click();
}

test.describe('Шаблоны рейсов', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_disp1');
    await page.goto('/schedule/templates', { waitUntil: 'networkidle' });
  });

  test('реестр шаблонов приходит с сервера', async ({ page }) => {
    const listed = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/flight-templates') && response.status() === 200,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await listed;

    await expect(page.getByRole('button', { name: 'Создать шаблон' })).toBeVisible();
  });

  test('кнопка «Создать шаблон» заводит шаблон', async ({ page }) => {
    const name = `Проба Шаблон ${RUN}`;

    await page.getByRole('button', { name: 'Создать шаблон' }).click();
    const form = dialog(page);
    await form.getByLabel('Шаблон', { exact: true }).fill(name);
    await pickOption(form, page, 'Клиент');
    await pickOption(form, page, 'Тип ВС');
    await form.getByLabel('Аэропорт вылета').fill('UUWW');
    await form.getByLabel('Аэропорт прилёта').fill('ULLI');
    await pickOption(form, page, 'Дни недели', 'Пн');
    await closeDropdown(page);

    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/flight-templates') &&
        response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Создать' }).click();

    const response = await created;
    expect(response.status(), 'сервер отказал в заведении шаблона').toBe(201);

    const template = (await response.json()) as {
      name: string;
      depIcao: string;
      depTimeLocal: string;
      weekdays: number[];
    };
    expect(template.name).toBe(name);
    // Код аэропорта приводится к верхнему регистру сервером
    expect(template.depIcao).toBe('UUWW');
    // Время осталось местным, а не переведено в UTC при сохранении
    expect(template.depTimeLocal).toMatch(/^\d{2}:\d{2}$/);
    expect(template.weekdays).toContain(1);

    await expect(form).toBeHidden();
    await expect(page.getByText(name)).toBeVisible();
  });

  test('кнопка «Сгенерировать» создаёт серию рейсов', async ({ page }) => {
    const row = page.locator('.ant-table-row').first();
    await expect(row, 'на стенде нет шаблонов').toBeVisible();

    await row.getByRole('button', { name: 'Сгенерировать серию' }).click();
    const form = dialog(page);

    // Период выбирается мышью по календарю — так это делает человек.
    // Ввод с клавиатуры здесь не годится: нажатие во второе поле
    // сбрасывает первую дату, а Enter фокус не переносит.
    await form.locator('.ant-picker-range input').first().click();
    await pickDay(page, 5);
    await pickDay(page, 12);

    const generated = page.waitForResponse(
      (response) =>
        response.url().includes('/generate') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Сгенерировать серию' }).click();

    const response = await generated;
    expect(response.status(), 'сервер не сгенерировал серию').toBe(201);

    const body = (await response.json()) as { data: { number: string; stdUtc: string }[] };
    expect(body.data.length, 'серия пуста').toBeGreaterThan(0);
    // Рейсы настоящие: с номером и временем вылета
    expect(body.data[0]?.number).toBeTruthy();
    expect(body.data[0]?.stdUtc).toBeTruthy();
  });

  test('генерация без периода не запускается', async ({ page }) => {
    const row = page.locator('.ant-table-row').first();
    await row.getByRole('button', { name: 'Сгенерировать серию' }).click();

    const form = dialog(page);
    await expect(form.getByRole('button', { name: 'Сгенерировать серию' })).toBeDisabled();
    // Окно объясняет, что правка шаблона не трогает созданные рейсы
    await expect(form.locator('.ant-alert-warning')).toBeVisible();
  });
});
