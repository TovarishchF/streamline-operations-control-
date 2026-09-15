import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки экрана отчётности `[ТЗ 3.6.1, 3.6.3]`.
 *
 * Проверяется не то, что кнопка нажимается, а то, что за ней стоит работа
 * сервера: «Построить» приносит строки и колонки, кнопка формата — готовую
 * подписанную ссылку, «Добавить подписку» — запись, которая видна после
 * перезагрузки страницы.
 *
 * Отдельно проверяется, что отписка не удаляет запись молча, а именно
 * убирает её из списка активных: поведение сервера здесь неочевидное,
 * и интерфейс обязан показывать его так же, как оно устроено.
 */

/** Суффикс прогона: повторный запуск не должен натыкаться на свои же данные. */
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

const RECIPIENT = `proba.${RUN.toLowerCase()}@example.test`;

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

/**
 * Выбор значения в открывающемся списке Ant Design.
 *
 * Список открывается нажатием на оболочку поля, а не на вложенный ввод:
 * у заполненного списка ввод перекрыт подписью выбранного значения,
 * и нажатие по нему не доходит.
 */
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
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option', { hasText: option }).first().click();
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

/** Период, заведомо накрывающий рейсы стенда: он строится от текущей даты. */
async function fillPeriod(page: Page): Promise<void> {
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
  const to = new Date(today.getTime() + 30 * 24 * 3600 * 1000);
  const format = (value: Date): string =>
    `${String(value.getDate()).padStart(2, '0')}.${String(value.getMonth() + 1).padStart(2, '0')}.${String(value.getFullYear())}`;

  const range = page.locator('.ant-picker-range input');
  await range.first().click();
  await range.first().fill(format(from));
  await page.keyboard.press('Enter');
  await range.nth(1).fill(format(to));
  await page.keyboard.press('Enter');
}

test.describe('Отчётность', () => {
  test.beforeEach(async ({ page }) => {
    // Руководитель: у него есть и операционные, и финансовые отчёты
    // (`SPEC § 2.2`). Разграничение прав проверяется тестами на сервере.
    await signInAs(page, 'usr_mgr');
  });

  test('каталог отчётов приходит с сервера', async ({ page }) => {
    // Путь с префиксом API: страница приложения тоже кончается на `/reports`,
    // и без префикса ожидание поймало бы HTML навигации.
    const catalog = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/reports') && response.status() === 200,
    );
    await page.goto('/reports', { waitUntil: 'networkidle' });

    // Семь обязательных отчётов ТЗ 3.6.1 — по ответу сервера, а не по вёрстке
    const body = (await (await catalog).json()) as { data: { code: string }[] };
    expect(body.data).toHaveLength(7);

    // Именно карточки каталога: то же название может стоять и в списке
    // подписок, оставшемся от предыдущего прогона.
    const titles = page.locator('.ant-card-head-title');
    await expect(titles.filter({ hasText: 'Финансовый: доходы, расходы, маржа' })).toBeVisible();
    await expect(titles.filter({ hasText: 'Реестр нарушений SLA' })).toBeVisible();
  });

  test('кнопка «Построить» приносит строки финансового отчёта', async ({ page }) => {
    await page.goto('/reports/financial', { waitUntil: 'networkidle' });

    // До нажатия отчёт не строится: тяжёлую выборку не делают на каждое
    // движение в форме отбора.
    await expect(page.getByText('нажмите «Построить»')).toBeVisible();

    await fillPeriod(page);
    const built = page.waitForResponse(
      (response) => response.url().includes('/reports/financial?') && response.status() === 200,
    );
    await page.getByRole('button', { name: 'Построить' }).click();
    const response = await built;

    const body = (await response.json()) as {
      columns: { key: string }[];
      rows: Record<string, unknown>[];
    };
    expect(body.columns.map((column) => column.key)).toContain('margin');

    // Колонки таблицы взяты из ответа, а не объявлены в браузере
    await expect(page.getByRole('columnheader', { name: 'Маржа', exact: true })).toBeVisible();
    if (body.rows.length > 0) {
      await expect(page.getByText('Итого')).toBeVisible();
    }
  });

  test('кнопки форматов выдают подписанную ссылку', async ({ page }) => {
    await page.goto('/reports/financial', { waitUntil: 'networkidle' });
    await fillPeriod(page);
    await page.getByRole('button', { name: 'Построить' }).click();

    for (const format of ['PDF', 'CSV', 'XLSX', 'XML'] as const) {
      const exported = page.waitForResponse(
        (response) =>
          response.url().includes('/reports/financial/export') && response.request().method() === 'POST',
      );
      const popup = page.waitForEvent('popup');
      // Доступное имя кнопки с иконкой включает подпись иконки
      // («file-excel XLSX»), поэтому совпадение не точное.
      await page.getByRole('button', { name: format }).click();

      const response = await exported;
      expect(response.status(), `${format}: сервер отказал в выгрузке`).toBe(202);

      const ticket = (await response.json()) as { status: string; downloadUrl: string | null };
      expect(ticket.status).toBe('ready');
      expect(ticket.downloadUrl, `${format}: ссылки нет`).toContain(`.${format.toLowerCase()}`);
      // Ссылка подписанная и временная, а не путь к файлу на сервере
      expect(ticket.downloadUrl).toContain('X-Amz-Signature');

      const opened = await popup;
      await opened.close();
    }
  });

  test('подписка на отчёт заводится, меняется и отключается', async ({ page }) => {
    await page.goto('/reports', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Добавить подписку' }).click();
    const form = dialog(page);
    await pickOption(form, page, 'Отчёт', 'Реестр нарушений SLA');
    await pickOption(form, page, 'Расписание', 'Ежедневно');
    await form.getByLabel('Получатели').click();
    await page.keyboard.type(RECIPIENT);
    await page.keyboard.press('Enter');
    await form.getByRole('button', { name: 'Создать' }).click();
    await expectSaved(page);

    const row = page.locator('.ant-list-item', { hasText: RECIPIENT });
    await expect(row).toBeVisible();

    // Подписка на сервере, а не в состоянии вкладки
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('.ant-list-item', { hasText: RECIPIENT })).toBeVisible();

    // Изменение: расписание меняется на еженедельное
    await page.locator('.ant-list-item', { hasText: RECIPIENT })
      .getByRole('button', { name: 'Изменить' }).click();
    const edit = dialog(page);
    await pickOption(edit, page, 'Расписание', 'Еженедельно');
    await edit.getByRole('button', { name: 'Сохранить' }).click();
    await expectSaved(page);
    await expect(
      page.locator('.ant-list-item', { hasText: RECIPIENT }).getByText('Еженедельно'),
    ).toBeVisible();

    // Отписка: запись уходит из списка активных
    await page.locator('.ant-list-item', { hasText: RECIPIENT })
      .getByRole('button', { name: 'Отписаться' }).click();
    await page.locator('.ant-popover-buttons, .ant-popconfirm-buttons')
      .getByRole('button', { name: 'Да' }).click();

    await expect(page.locator('.ant-list-item', { hasText: RECIPIENT })).toHaveCount(0);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('.ant-list-item', { hasText: RECIPIENT })).toHaveCount(0);
  });
});
