import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { Api, freeAircraft, onboardVendor, VENDOR_PASSWORD, type ScenarioVendor } from './helpers/scenario';
import { ACCOUNTS, signInAs, signInWith } from './helpers/session';

/**
 * Сквозной сценарий `SPEC.md § 12` (приёмка M10).
 *
 * Создать рейс → заказать три услуги у разных поставщиков → получить отказ
 * по одной и переназначить → подтвердить остальные в портале поставщика →
 * выставить котировку → провести рейс через все статусы → выставить счёт
 * по факту → сформировать заявки на оплату → загрузить счёт поставщика
 * с расхождением → разобрать расхождение → проверить маржу, аудит
 * и содержимое исходящих.
 *
 * Всё, что делает человек, делается в браузере под его ролью. Через API —
 * только подготовка того, чего в наборе генератора нет: поставщики с
 * договорами и ценами в аэропорту сценария (`helpers/scenario.ts`).
 * Маршрут — Казань → Екатеринбург: аэропорты не координируемые, рейс
 * внутренний, и слоты с разрешениями не уводят сценарий в сторону.
 */

test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36).slice(-6);
const DEP = 'UWKD';
const ARR = 'USSS';

/** Услуги сценария: три категории, у наземного обслуживания обязателен акт. */
const SERVICES = { handling: 'HND_BASIC', catering: 'CAT_BAR', transport: 'TRN_CREW' } as const;

interface State {
  clientName: string;
  aircraft: string;
  stdUtc: string;
  flightId: string;
  flightNumber: string;
  rejecting: ScenarioVendor;
  replacement: ScenarioVendor;
  catering: ScenarioVendor;
  transport: ScenarioVendor;
}

const state = {} as State;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Время для поля даты: `ДД.ММ.ГГГГ ЧЧ:ММ` в UTC. */
function typed(iso: string): string {
  const at = new Date(iso);
  return `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/**
 * Ошибки консоли и необработанные исключения страниц сценария: приёмка M10
 * требует прохождения «без ошибок в консоли», и проверяется это здесь же.
 */
const consoleErrors: string[] = [];

async function pageAs(browser: Browser, who: { role?: string; username?: string }): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`${page.url()}: ${error.message}`);
  });
  if (who.username) await signInWith(page, who.username, VENDOR_PASSWORD);
  else await signInAs(page, who.role ?? 'usr_disp1');
  return page;
}

/** Выбор в списке Ant Design с поиском: набрать текст, кликнуть совпадение. */
async function choose(page: Page, field: Locator, search: string, option: string | RegExp = search): Promise<void> {
  await field.locator('.ant-select-selector').click();
  await page.keyboard.type(search);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .last()
    .locator('.ant-select-item-option', { hasText: option })
    .first()
    .click();
}

function modal(page: Page): Locator {
  return page.locator('.ant-modal-content').last();
}

/** Переход статуса рейса в панели карточки с подтверждением. */
async function transition(page: Page, label: string): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.url().endsWith('/status') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await modal(page).getByRole('button', { name: 'Подтвердить' }).click();
  expect((await answered).status(), `переход «${label}» отклонён`).toBe(200);
  await expect(modal(page)).toBeHidden();
}

test.afterEach(() => {
  const errors = consoleErrors.splice(0);
  expect(errors, `ошибки в консоли браузера: ${errors.join(' | ')}`).toEqual([]);
});

test.beforeAll(async ({ playwright }) => {
  // Четыре регистрации с письмом через очередь (раз в 30 с) — не быстро.
  test.setTimeout(600_000);
  const request = await playwright.request.newContext();
  const admin = await Api.as(request, ACCOUNTS['usr_admin'] ?? 'volkova');

  const clock = await admin.get<{ nowUtc: string }>('/clock');
  const now = new Date(clock.nowUtc);
  // Вылет через четверо суток в 10:00Z: лидтаймы услуг соблюдены.
  const std = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 4, 10, 0));
  state.stdUtc = std.toISOString();

  const services = await admin.get<{ data: { id: string; code: string }[] }>('/catalog/services?perPage=200');
  const serviceId = (code: string): string => {
    const found = services.data.find((item) => item.code === code);
    if (!found) throw new Error(`услуги ${code} нет в каталоге: make seed-reference`);
    return found.id;
  };

  const period = {
    validFrom: new Date(now.getTime() - 86_400_000).toISOString(),
    validTo: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
  };
  const onboard = (key: string, name: string, category: string, code: string, amount: string) =>
    onboardVendor(request, admin, {
      run: RUN, key, name: `${name} ${RUN.toUpperCase()}`, category, airport: DEP,
      prices: [{ serviceId: serviceId(code), amount }], ...period,
    });

  state.rejecting = await onboard('hnd1', 'Перрон Сценарий', 'handling', SERVICES.handling, '42000.00');
  state.replacement = await onboard('hnd2', 'Хэндлинг Замена', 'handling', SERVICES.handling, '45000.00');
  state.catering = await onboard('cat', 'Бортовой Буфет', 'catering', SERVICES.catering, '8000.00');
  state.transport = await onboard('trn', 'Трансфер Экипажа', 'transport', SERVICES.transport, '3500.00');

  // Клиент — тот, у кого есть портальная учётная запись генератора.
  const clientUser = await Api.as(request, ACCOUNTS['usr_client'] ?? 'lebedeva');
  const me = await clientUser.get<{ user: { clientId: string } }>('/auth/me');
  state.clientName = (await admin.get<{ name: string }>(`/clients/${me.user.clientId}`)).name;
  state.aircraft = await freeAircraft(admin, state.stdUtc);
  await request.dispose();
});

test('диспетчер создаёт рейс', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_disp1' });
  await page.goto('/flights/new');

  const item = (label: string): Locator => page.locator('.ant-form-item').filter({ hasText: label }).first();
  await choose(page, item('Клиент'), state.clientName);
  await choose(page, item('Аэропорт вылета'), DEP);
  await choose(page, item('Аэропорт прилёта'), ARR);
  await choose(page, item('Борт'), state.aircraft);

  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/flights') && response.request().method() === 'POST',
  );
  const std = page.locator('.ant-form-item', { hasText: 'Вылет' }).last().locator('input').first();
  await std.click();
  await std.fill(typed(state.stdUtc));
  await std.press('Enter');

  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const flight = (await response.json()) as { id: string; number: string };
  state.flightId = flight.id;
  state.flightNumber = flight.number;
  await expect(page).toHaveURL(new RegExp(`/flights/${flight.id}`));
  await expect(page.getByText(flight.number).first()).toBeVisible();
});

test('диспетчер заказывает три услуги у разных поставщиков', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await pageAs(browser, { role: 'usr_disp1' });
  await page.goto(`/flights/${state.flightId}/services`);

  const order = async (
    category: string,
    code: string,
    vendor: ScenarioVendor,
    attributes: Record<string, string> = {},
  ): Promise<void> => {
    await page.getByRole('button', { name: 'Заказать услугу' }).first().click();
    const wizard = modal(page);
    await expect(wizard.getByText('Заказ услуги')).toBeVisible();
    const item = (label: string): Locator => wizard.locator('.ant-form-item').filter({ hasText: label }).first();
    await item('Категория').locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last()
      .locator('.ant-select-item-option', { hasText: category }).click();
    await item('Услуга').locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last()
      .locator('.ant-select-item-option', { hasText: `(${code})` }).click();
    for (const [label, value] of Object.entries(attributes)) {
      await item(label).locator('input').fill(value);
    }
    await wizard.getByRole('button', { name: 'Далее' }).click();
    await wizard.locator('.ant-list-item', { hasText: vendor.name }).click();
    await wizard.getByRole('button', { name: 'Далее' }).click();

    const placed = page.waitForResponse(
      (response) => response.url().endsWith('/services') && response.request().method() === 'POST',
    );
    await wizard.getByRole('button', { name: 'Отправить заявку' }).click();
    const response = await placed;
    expect(response.status(), await response.text()).toBe(201);
    await expect(page.locator('.ant-table-row', { hasText: vendor.name })).toBeVisible();
  };

  await order('Наземное обслуживание', SERVICES.handling, state.rejecting);
  await order('Кейтеринг', SERVICES.catering, state.catering);
  await order('Транспорт', SERVICES.transport, state.transport, { Пассажиров: '4' });

  await expect(page.locator('.ant-table-row')).toHaveCount(3);
});

test('поставщик отказывает, диспетчер переназначает', async ({ browser }) => {
  const vendor = await pageAs(browser, { username: state.rejecting.username });
  await vendor.goto('/portal/vendor/orders');
  const row = vendor.locator('.ant-table-row').first();
  await row.getByRole('button', { name: 'Отказать' }).click();
  await vendor.locator('.ant-modal-confirm textarea').fill('Нет свободной бригады на это время');
  await vendor.locator('.ant-modal-confirm-btns').getByRole('button', { name: 'Отказать' }).click();
  await expect(row).toContainText('Отклонена');

  const page = await pageAs(browser, { role: 'usr_disp1' });
  await page.goto(`/flights/${state.flightId}/services`);
  const rejected = page.locator('.ant-table-row', { hasText: 'Отклонена' });
  await rejected.getByRole('button', { name: 'Переназначить' }).click();
  const suggest = modal(page);
  await expect(suggest.getByText('Подбор поставщика')).toBeVisible();
  await suggest.locator('.ant-table-row', { hasText: state.replacement.name }).locator('.ant-radio-input').check();
  await suggest.locator('textarea').fill('Замена после отказа поставщика');

  const reassigned = page.waitForResponse((response) => response.url().endsWith('/reassign'));
  await suggest.getByRole('button', { name: 'Переназначить на выбранного' }).click();
  expect((await reassigned).status()).toBe(201);
  await expect(suggest).toBeHidden();
  // Новая заявка — строка заявки (ключ ord_), а не строка таблицы подбора
  await expect(
    page.locator('.ant-table-row[data-row-key^="ord_"]', { hasText: state.replacement.name }),
  ).toContainText('Заказана');
});

test('остальные поставщики подтверждают заявки в портале', async ({ browser }) => {
  for (const vendor of [state.replacement, state.catering, state.transport]) {
    const page = await pageAs(browser, { username: vendor.username });
    await page.goto('/portal/vendor/orders');
    const row = page.locator('.ant-table-row').first();
    await row.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(row).toContainText('Подтверждена');
    await page.context().close();
  }
});

test('финансист выставляет котировку', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_fin' });
  await page.goto(`/flights/${state.flightId}/documents`);
  await page.getByRole('button', { name: 'Сформировать котировку' }).click();
  await modal(page).getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/billing\/quotes\/qte_/);
  await page.getByRole('button', { name: 'Выставить' }).click();
  await expect(page.getByText(/Документ выставлен под номером/)).toBeVisible();
});

test('диспетчер проводит рейс до прилёта', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_disp1' });
  await page.goto(`/flights/${state.flightId}`);
  await transition(page, 'Взять в работу');
  // Отказ улажен заменой: условия «Готов к вылету» выполнены
  await transition(page, 'Готов к вылету');
  await transition(page, 'Вылетел');
  await transition(page, 'Прилетел');
  await expect(page.getByText('Прилетел').first()).toBeVisible();
});

test('поставщики отмечают исполнение с фактом и актом', async ({ browser }) => {
  test.setTimeout(180_000);
  const start = typed(new Date(new Date(state.stdUtc).getTime() - 60 * 60_000).toISOString());
  const end = typed(new Date(new Date(state.stdUtc).getTime() - 20 * 60_000).toISOString());

  for (const vendor of [state.replacement, state.catering, state.transport]) {
    const page = await pageAs(browser, { username: vendor.username });
    await page.goto('/portal/vendor/orders');
    const row = page.locator('.ant-table-row').first();
    await row.getByRole('button', { name: 'Начать' }).click();
    await expect(row).toContainText('В процессе');

    await row.getByRole('button', { name: 'Завершить' }).click();
    const dialog = modal(page);
    for (const [label, value] of [['Фактическое начало', start], ['Фактическое окончание', end]] as const) {
      const input = dialog.locator('.ant-form-item', { hasText: label }).locator('input').first();
      await input.click();
      await input.fill(value);
      await input.press('Enter');
    }
    if (vendor === state.replacement) {
      // Наземное обслуживание без акта не закрывается
      await dialog.locator('input[type=file]').setInputFiles({
        name: `act-${RUN}.pdf`,
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n% e2e act\ntrailer<<>>\n%%EOF\n'),
      });
      await expect(dialog.getByText(`act-${RUN}.pdf`)).toBeVisible({ timeout: 20_000 });
    }
    const finished = page.waitForResponse(
      (response) => response.url().endsWith('/status') && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Подтвердить' }).click();
    const response = await finished;
    expect(response.status(), await response.text()).toBe(200);
    await expect(row).toContainText('Выполнена');
    await page.context().close();
  }
});

test('финансист выставляет счёт по факту, диспетчер завершает рейс', async ({ browser }) => {
  const finance = await pageAs(browser, { role: 'usr_fin' });
  await finance.goto(`/flights/${state.flightId}/documents`);
  await finance.getByRole('button', { name: 'Сформировать счёт' }).click();
  await modal(finance).getByRole('button', { name: 'Создать' }).click();
  await expect(finance).toHaveURL(/\/billing\/invoices\/inv_/);
  // Строки счёта — по фактически оказанному: три выполненные услуги
  await expect(finance.locator('.ant-table-row')).toHaveCount(3);
  const issued = finance.waitForResponse(
    (response) => response.url().endsWith('/issue') && response.request().method() === 'POST',
  );
  await finance.getByRole('button', { name: 'Выставить' }).click();
  await expect(finance.getByText(/Документ выставлен под номером/)).toBeVisible();

  // Итог на экране — тот же, что в API, до копейки. Сервер округляет итог
  // один раз до двух знаков (ADR-002), поэтому знаки после второго — нули,
  // а PDF и XLSX сверяются с тем же итогом в `billing/tests/test_export.py`.
  const invoice = (await (await issued).json()) as { totals: { grandTotal: { amount: string } } };
  const [whole = '', fraction = ''] = invoice.totals.grandTotal.amount.split('.');
  expect(fraction.slice(2)).toMatch(/^0*$/);
  const onScreen = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction.slice(0, 2).padEnd(2, '0')}`;
  await expect(finance.locator('.ant-descriptions-item', { hasText: 'Всего к оплате' })).toContainText(onScreen);

  const page = await pageAs(browser, { role: 'usr_disp1' });
  await page.goto(`/flights/${state.flightId}`);
  await transition(page, 'Завершить');
  await expect(page.getByText('Завершён').first()).toBeVisible();
});

test('заявки на оплату сформированы по выполненным услугам', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_fin' });
  await page.goto('/billing/payables');
  for (const vendor of [state.replacement, state.catering, state.transport]) {
    await expect(page.locator('.ant-table-row', { hasText: vendor.name }).first()).toBeVisible();
  }
  // У отказавшего поставщика обязательства нет: он ничего не оказал
  await expect(page.locator('.ant-table-row', { hasText: state.rejecting.name })).toHaveCount(0);
});

test('счёт поставщика с расхождением загружается и разбирается', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_fin' });
  await page.goto('/billing/reconciliation');
  await page.getByRole('button', { name: 'Импортировать счёт' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.ant-select-selector').click();
  await page.keyboard.type(state.catering.name);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last()
    .locator('.ant-select-item-option', { hasText: state.catering.name }).click();

  // Поставщик выставил 9 000 вместо согласованных 8 000 — расхождение цены.
  const today = new Date();
  const date = `${pad(today.getUTCDate())}.${pad(today.getUTCMonth() + 1)}.${String(today.getUTCFullYear())}`;
  const csv =
    'Номер счёта;Дата счёта;Валюта;Аэропорт ИКАО;Дата услуги;Код услуги;Количество;Цена за единицу;Сумма\n' +
    `E2E-SCN-${RUN};${date};RUB;${DEP};${date} 12:00;${SERVICES.catering};1;9000,00;9000,00\n`;
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'scenario.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8'),
  });
  await dialog.getByRole('button', { name: 'Импортировать' }).click();
  await expect(page).toHaveURL(/\/billing\/reconciliation\/vin_/);

  const row = page.locator('.ant-table-row', { hasText: 'Расхождение цены' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Разобрать' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Цена по договору 8 000, претензия поставщику');
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
  await expect(row.getByRole('button', { name: 'Разобрать' })).toHaveCount(0);
});

test('маржа, аудит и исходящие отражают сценарий', async ({ browser }) => {
  const page = await pageAs(browser, { role: 'usr_fin' });
  await page.goto(`/flights/${state.flightId}/finance`);
  // Доход и маржа посчитаны сервером и показаны суммами в валюте расчётов
  // клиента, а не прочерком
  const tiles = page.locator('.ant-statistic');
  await expect(tiles.first()).toBeVisible();
  await expect(tiles.filter({ hasText: 'Доход' })).toContainText(/\d[\d\s]*,\d{2}\s[₽€$]/);
  await expect(tiles.filter({ hasText: 'Маржа' }).first()).toContainText(/\d,\d{2}\s[₽€$]/);

  await page.goto(`/flights/${state.flightId}/history`);
  const history = page.locator('.ant-table-tbody');
  await expect(history).toContainText('Поставщик переназначен');
  await expect(history).toContainText('Изменён статус');

  const dispatcher = await pageAs(browser, { role: 'usr_disp1' });
  await dispatcher.goto('/communications/outbox');
  // Клиенту ушло подтверждение рейса, поставщикам — заявки
  await expect(dispatcher.getByText(`Рейс ${state.flightNumber} подтверждён`).first()).toBeVisible();
});
