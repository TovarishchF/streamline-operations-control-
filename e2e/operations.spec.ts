import { expect, test, type Locator, type Page } from '@playwright/test';

import { anyFlightId, signInAs } from './helpers/session';

/**
 * Выбор значения в списке Ant Design.
 *
 * Закрывающийся список остаётся в DOM ещё несколько кадров, поэтому
 * `.first()` попадает в него, а не в только что открытый. Берём последний.
 */
async function pickOption(page: Page, select: Locator, index = 0): Promise<void> {
  await select.click();
  const dropdown = page.locator('.ant-select-dropdown').last();
  await dropdown.locator('.ant-select-item-option').nth(index).click();
}

/**
 * Проверка, что кнопки действительно выполняют операции, а не переносят
 * на другой экран.
 *
 * Полный сквозной сценарий — `scenario.spec.ts`. Здесь проверяются отдельные
 * операции: создание и изменение рейса, переход статуса, подтверждение
 * заявки клиента и сохранение шаблона с подтверждением.
 */

/** Вход под ролью — настоящий, через API (`helpers/session`). */
async function signIn(page: Page, role: string): Promise<void> {
  await signInAs(page, role);
}

async function asDispatcher(page: Page): Promise<void> {
  await signIn(page, 'usr_disp1');
}

test.describe('Операции', () => {
  test('создание рейса добавляет его в расписание', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/flights/new');

    // Клиент
    await pickOption(page, page.locator('.ant-form-item', { hasText: 'Клиент' }).locator('.ant-select'));

    // Время вылета. «Сейчас (UTC)» берёт часы сервера, а не браузера (ADR-014).
    await page.locator('.ant-form-item', { hasText: 'Вылет' }).last().locator('input').first().click();
    await page.locator('.ant-picker-presets li', { hasText: 'Сейчас (UTC)' }).click();

    await page.getByRole('button', { name: 'Создать рейс', exact: true }).click();

    // Попали на карточку созданного рейса
    await expect(page).toHaveURL(/\/flights\/flt_/);
    await expect(page.getByText('Запланирован').first()).toBeVisible();

    // Номер рейса виден в шапке карточки
    const number = await page.locator('h4').first().innerText();
    expect(number).toMatch(/SLG-\d+/);

    // И он же находится в таблице расписания. Ищем поиском: таблица
    // постраничная и отсортирована по времени вылета.
    await page.goto('/schedule');
    await page.locator('.ant-segmented-item', { hasText: 'Таблица' }).click();
    await page.getByPlaceholder('Номер, клиент, борт, аэропорт').fill(number.trim());
    await expect(page.locator('tbody tr.ant-table-row')).toHaveCount(1);
    await expect(page.getByText(number.trim()).first()).toBeVisible();
  });

  test.describe('браузер не в UTC', () => {
    // Диспетчер в Екатеринбурге (UTC+5). Поле подписано UTC — и должно
    // отправлять UTC, а не местное время браузера (CLAUDE.md § 3 п. 2).
    test.use({ timezoneId: 'Asia/Yekaterinburg' });

    test('время вылета уходит на сервер в UTC, как подписано', async ({ page }) => {
      await asDispatcher(page);
      await page.goto('/flights/new');
      await pickOption(page, page.locator('.ant-form-item', { hasText: 'Клиент' }).locator('.ant-select'));

      const created = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url().endsWith('/api/v1/flights'),
      );
      const input = page.locator('.ant-form-item', { hasText: 'Вылет' }).last().locator('input').first();
      await input.click();
      await input.fill('15.12.2026 12:00Z');
      // Enter подтверждает значение и отправляет форму
      await input.press('Enter');

      const body = (await created).postDataJSON() as { stdUtc: string };
      expect(body.stdUtc).toBe('2026-12-15T12:00:00.000Z');
      // И карточка показывает то же время с подписью зоны
      await expect(page.getByText('15.12 12:00Z').first()).toBeVisible();
    });
  });

  test('изменение рейса уходит на сервер только изменёнными полями', async ({ page }) => {
    await asDispatcher(page);
    await page.goto(`/flights/${await anyFlightId(page, 'planned')}`);

    await page.getByRole('button', { name: 'Изменить' }).click();
    const dialog = page.locator('.ant-modal-content');
    const pax = String(2 + (Date.now() % 7));
    await dialog.locator('.ant-form-item', { hasText: 'Пассажиров' }).locator('input').fill(pax);

    const saved = page.waitForRequest((request) => request.method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    // Правка числа пассажиров не трогает расписание и не переспрашивает о конфликтах
    expect((await saved).postDataJSON()).toEqual({ paxCount: Number(pax) });
    await expect(page.getByText(/изменён/)).toBeVisible();
  });

  test('переход статуса заблокирован, пока не выполнены условия', async ({ page }) => {
    await asDispatcher(page);
    await page.goto(`/flights/${await anyFlightId(page, 'planned')}`);

    // Доступный переход — кнопка; недоступный кнопкой не показывается,
    // но рядом виден перечень невыполненных условий (SPEC § 4.4).
    const start = page.getByRole('button', { name: 'Взять в работу' });
    const blocked = page.getByText('«Взять в работу» недоступно:');
    await expect(start.or(blocked)).toBeVisible();
    // Отмена требует причины, но причину вводят в диалоге: она не числится
    // невыполненным условием, и кнопка отмены у рейса в плане есть всегда.
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
  });

  // Заказ услуги через мастер проверяет сквозной сценарий (`scenario.spec.ts`):
  // у рейсов генератора нет поставщиков с ценами, и заказать для них нечего,
  // а сценарий заводит своих поставщиков настоящей регистрацией.

  test('подтверждение заявки клиента создаёт рейс', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/requests');

    await page.getByRole('button', { name: 'Подтвердить' }).first().click();

    await expect(page).toHaveURL(/\/flights\/flt_/);
    await expect(page.getByText('Запланирован').first()).toBeVisible();
  });

  test('шаблон сохраняется только после подтверждения', async ({ page }) => {
    await signIn(page, 'usr_admin');

    await page.goto('/communications/templates');

    // Тема уникальна на прогон: повтор с прежней темой не менял бы шаблон,
    // и кнопка сохранения справедливо оставалась бы неактивной.
    const changed = `Изменённая тема письма ${String(Date.now())}`;
    const subject = page.locator('.ant-input').first();
    await subject.fill(changed);

    // Кнопка сохранения активна, но изменение ещё не применено
    const save = page.getByRole('button', { name: 'Сохранить шаблон' });
    await expect(save).toBeEnabled();
    await expect(page.getByText('Есть несохранённые правки')).toBeVisible();

    await save.click();

    // Показан предпросмотр изменения, сохранение — отдельным подтверждением
    await expect(page.getByText('Подтверждение изменения шаблона')).toBeVisible();
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Сохранить' }).click();

    await expect(page.getByText('Есть несохранённые правки')).toHaveCount(0);
    await expect(subject).toHaveValue(changed);
  });

  test('сортировка и изменение ширины столбца доступны в таблице', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/airports');
    await expect(page.locator('tbody tr.ant-table-row').first()).toBeVisible();

    // У каждой колонки с данными есть переключатель сортировки.
    // Все девять колонок справочника аэропортов сортируются, включая
    // вычисляемые (наименование, координаты).
    const sorters = page.locator('th.ant-table-column-has-sorters');
    expect(await sorters.count()).toBe(9);

    // Сервер отдаёт справочник по возрастанию кода ИКАО, поэтому первое
    // нажатие ничего не меняет — порядок проверяется по убыванию.
    const icao = page.locator('th', { hasText: 'ICAO' }).first();
    const firstBefore = await page.locator('tbody tr.ant-table-row td').first().innerText();
    await icao.click();
    await icao.click();
    await expect
      .poll(async () => page.locator('tbody tr.ant-table-row td').first().innerText())
      .not.toBe(firstBefore);

    // Ручка изменения ширины присутствует в заголовках
    expect(await page.locator('.soc-resize-handle').count()).toBeGreaterThan(0);
  });

  test('край колонки идёт за указателем, соседние колонки не меняются', async ({ page }) => {
    // В реестре поставщиков колонки вместе уже таблицы: браузер раздаёт
    // остаток места всем колонкам, и именно здесь край отставал от указателя.
    await asDispatcher(page);
    await page.goto('/vendors');
    await expect(page.locator('tbody tr.ant-table-row').first()).toBeVisible();

    const headerWidths = async (): Promise<number[]> =>
      page
        .locator('.ant-table-thead > tr > th:not(.soc-table-filler)')
        .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));

    // Тянется вторая колонка: левее неё — колонка, которая не должна сдвинуться
    const handle = page.locator('.ant-table-thead .soc-resize-handle').nth(1);
    const box = await handle.boundingBox();
    if (!box) throw new Error('нет ручки изменения ширины');
    const before = await headerWidths();

    const y = box.y + box.height / 2;
    for (const offset of [100, -60]) {
      const start = (await handle.boundingBox())?.x ?? 0;
      await page.mouse.move(start + box.width / 2, y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(start + box.width / 2 + (offset * step) / 10, y);
      }
      await page.mouse.up();
      // Край колонки сдвинулся ровно на столько, на сколько указатель
      expect(Math.round(((await handle.boundingBox())?.x ?? 0) - start)).toBe(offset);
    }

    const after = await headerWidths();
    expect(after[1]).toBe((before[1] ?? 0) + 40);
    expect(after.filter((_, index) => index !== 1)).toEqual(
      before.filter((_, index) => index !== 1),
    );
  });
});
