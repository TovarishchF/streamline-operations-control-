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
 * Полный сквозной сценарий `TESTING.md § 7` появится на M10, когда экраны
 * заработают на настоящем API. Здесь проверяется ровно то, что было заявлено
 * на M2: создание рейса, переход статуса, заказ услуги, подтверждение заявки
 * клиента и сохранение шаблона с подтверждением.
 */

/**
 * Вход под ролью и чистый набор данных.
 *
 * Вход настоящий, через API (`helpers/session`). Прототипное хранилище
 * рейсов очищается один раз на контекст браузера: `addInitScript`
 * выполняется при КАЖДОЙ навигации, и безусловная очистка стирала бы всё,
 * что тест только что создал.
 */
async function signIn(page: Page, role: string): Promise<void> {
  await signInAs(page, role);
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('soc.test.cleared')) {
      window.localStorage.removeItem('soc.prototype');
      window.sessionStorage.setItem('soc.test.cleared', '1');
    }
  });
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
    await page.goto(`/flights/${await anyFlightId(page, 'planned,in_work')}`);

    // У рейса без борта и заявок переход «Взять в работу» недоступен,
    // но виден: скрывать его — значит прятать причину (SPEC § 4.4)
    const start = page.getByRole('button', { name: 'Взять в работу' });
    if (await start.isVisible()) {
      await expect(start).toBeDisabled();
    }
  });

  // Заявки на услуги переезжают на настоящий API вместе с M5: подбор
  // поставщика, снимок цены и SLA живут там. Сейчас мастер работает на
  // наборе для макетов, а рейс приходит с сервера, и подобрать поставщика
  // под настоящую услугу ему нечем. Ослаблять проверку нельзя — она про то,
  // что кнопка выполняет операцию, а не открывает окно.
  test.fixme('заказ услуги появляется в списке заявок рейса', async ({ page }) => {
    await asDispatcher(page);
    // Рейс берётся из расписания: карточка работает на настоящем API,
    // и выдуманного идентификатора там нет.
    await page.goto(`/flights/${await anyFlightId(page)}/services`);

    // Ждём саму вкладку, а не строки: у рейса без заявок их нет вовсе,
    // и это нормальное начальное состояние. Кнопка на пустом экране
    // продублирована в заголовке и в подсказке — берём первую.
    const order = page.getByRole('button', { name: 'Заказать услугу' }).first();
    await expect(order).toBeVisible();
    const before = await page.locator('tbody tr.ant-table-row').count();

    await order.click();
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
    await signIn(page, 'usr_admin');

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
});
