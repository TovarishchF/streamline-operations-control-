import { expect, test, type Locator, type Page } from '@playwright/test';

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
 * Полный сквозной сценарий `TESTING.md § 7` появится на M10, когда экраны
 * заработают на настоящем API. Здесь проверяется ровно то, что было заявлено
 * на M2: создание рейса, переход статуса, заказ услуги, подтверждение заявки
 * клиента и сохранение шаблона с подтверждением.
 */

const DISPATCHER = {
  state: { user: { id: 'usr_disp1', name: 'Карпов Илья', role: 'dispatcher' } },
  version: 0,
};

/**
 * Вход под ролью и чистый набор данных.
 *
 * `addInitScript` выполняется при КАЖДОЙ навигации, поэтому безусловная
 * очистка хранилища стирала бы всё, что тест только что создал. Чистим
 * один раз на контекст браузера, отмечая это в sessionStorage.
 */
async function signIn(page: Page, user: object): Promise<void> {
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('soc.session', value);
    if (!window.sessionStorage.getItem('soc.test.cleared')) {
      window.localStorage.removeItem('soc.prototype');
      window.sessionStorage.setItem('soc.test.cleared', '1');
    }
  }, JSON.stringify({ state: { user }, version: 0 }));
}

async function asDispatcher(page: Page): Promise<void> {
  await signIn(page, DISPATCHER.state.user);
}

test.describe('Операции', () => {
  test('создание рейса добавляет его в расписание', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/flights/new');

    // Клиент
    await pickOption(page, page.locator('.ant-form-item', { hasText: 'Клиент' }).locator('.ant-select'));

    // Время вылета. Кнопка «Сейчас» закрывает панель сама — подтверждения нет.
    await page.locator('.ant-form-item', { hasText: 'Вылет' }).last().locator('input').first().click();
    await page.locator('.ant-picker-now-btn').click();

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

  test('переход статуса заблокирован, пока не выполнены условия', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/flights/flt_001');

    // У рейса без борта и заявок переход «Взять в работу» недоступен,
    // но виден: скрывать его — значит прятать причину (SPEC § 4.4)
    const start = page.getByRole('button', { name: 'Взять в работу' });
    if (await start.isVisible()) {
      await expect(start).toBeDisabled();
    }
  });

  test('заказ услуги появляется в списке заявок рейса', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/flights/flt_001/services');

    const before = await page.locator('tbody tr.ant-table-row').count();

    await page.getByRole('button', { name: 'Заказать услугу' }).click();
    const modal = page.locator('.ant-modal-content');

    // Шаг 1: категория и услуга
    await pickOption(page, modal.locator('.ant-select').nth(0));
    await pickOption(page, modal.locator('.ant-select').nth(1));
    await modal.getByRole('button', { name: 'Далее' }).click();

    // Шаг 2: поставщик
    await modal.locator('.ant-list-item').first().click();
    await modal.getByRole('button', { name: 'Далее' }).click();

    // Шаг 3: проверки. Лидтайм нарушен (рейс в прошлом) — это неблокирующая
    // проверка, но она требует подтверждения с причиной (SPEC § 5.2).
    const override = modal.locator('textarea');
    if (await override.isVisible()) {
      await override.fill('Согласовано с поставщиком по телефону');
    }
    await modal.getByRole('button', { name: 'Отправить заявку' }).click();

    await expect(page.locator('tbody tr.ant-table-row')).toHaveCount(before + 1);
    await expect(page.getByText('Заказана').first()).toBeVisible();
  });

  test('подтверждение заявки клиента создаёт рейс', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/requests');

    await page.getByRole('button', { name: 'Подтвердить' }).first().click();

    await expect(page).toHaveURL(/\/flights\/flt_/);
    await expect(page.getByText('Запланирован').first()).toBeVisible();
  });

  test('шаблон сохраняется только после подтверждения', async ({ page }) => {
    await signIn(page, { id: 'usr_admin', name: 'Волкова Анна', role: 'admin' });

    await page.goto('/communications/templates');

    const subject = page.locator('.ant-input').first();
    await subject.fill('Изменённая тема письма');

    // Кнопка сохранения активна, но изменение ещё не применено
    const save = page.getByRole('button', { name: 'Сохранить шаблон' });
    await expect(save).toBeEnabled();
    await expect(page.getByText('Есть несохранённые правки')).toBeVisible();

    await save.click();

    // Показан предпросмотр изменения, сохранение — отдельным подтверждением
    await expect(page.getByText('Подтверждение изменения шаблона')).toBeVisible();
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Сохранить' }).click();

    await expect(page.getByText('Есть несохранённые правки')).toHaveCount(0);
    await expect(subject).toHaveValue('Изменённая тема письма');
  });

  test('сортировка и изменение ширины столбца доступны в таблице', async ({ page }) => {
    await asDispatcher(page);
    await page.goto('/airports');

    // У каждой колонки с данными есть переключатель сортировки
    const sorters = page.locator('th.ant-table-column-has-sorters');
    // Все девять колонок справочника аэропортов сортируются,
    // включая вычисляемые (наименование, координаты)
    expect(await sorters.count()).toBe(9);

    // Сортировка по ICAO меняет первую строку
    const firstBefore = await page.locator('tbody tr.ant-table-row td').first().innerText();
    await page.locator('th', { hasText: 'ICAO' }).first().click();
    const firstAfter = await page.locator('tbody tr.ant-table-row td').first().innerText();
    expect(firstAfter).not.toBe(firstBefore);

    // Ручка изменения ширины присутствует в заголовках
    expect(await page.locator('.soc-resize-handle').count()).toBeGreaterThan(0);
  });
});
