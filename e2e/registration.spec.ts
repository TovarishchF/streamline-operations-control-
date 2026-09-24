import { expect, test } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Регистрация заказчика и поставщика `[ТЗ 4.3]` (ADR-037).
 *
 * Проверяется работа за кнопкой, а не наличие полей: заявка должна
 * оказаться на сервере, а поставщик — в очереди у руководителя.
 */

const RUN = Date.now().toString(36).slice(-6).toLowerCase();

test('заказчик подаёт заявку и получает указание проверить почту', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Я — заказчик')).toBeVisible();

  await dialog.getByLabel('Название организации').fill(`Чартер ${RUN}`);
  await dialog.getByLabel('ФИО').fill('Соболева Мария Львовна');
  await dialog.getByLabel('Электронная почта').fill(`client-${RUN}@example.test`);
  await dialog.getByLabel('Пароль', { exact: true }).fill('Registracia-Parol-2026');
  await dialog.getByLabel('Пароль ещё раз').fill('Registracia-Parol-2026');
  await dialog.getByRole('button', { name: 'Зарегистрироваться' }).click();

  await expect(dialog.getByText('Проверьте почту')).toBeVisible({ timeout: 15_000 });
});

test('поставщик заполняет категории и уходит на согласование', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await dialog.getByText('Я — поставщик').click();
  await expect(dialog.getByText(/уходит на согласование/)).toBeVisible();

  await dialog.getByLabel('Название организации').fill(`Хандлинг ${RUN}`);

  // Категории — обязательны: без них решение о поставщике принять нельзя.
  await dialog.locator('.ant-form-item').filter({ hasText: 'Категории услуг' })
    .locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .locator('.ant-select-item-option', { hasText: 'Наземное обслуживание' }).first().click();
  await page.keyboard.press('Escape');

  await dialog.getByLabel('ФИО').fill('Лавров Пётр Сергеевич');
  await dialog.getByLabel('Электронная почта').fill(`vendor-${RUN}@example.test`);
  await dialog.getByLabel('Пароль', { exact: true }).fill('Registracia-Parol-2026');
  await dialog.getByLabel('Пароль ещё раз').fill('Registracia-Parol-2026');
  await dialog.getByRole('button', { name: 'Отправить заявку' }).click();

  await expect(dialog.getByText('Проверьте почту')).toBeVisible({ timeout: 15_000 });
});

test('руководитель видит очередь заявок', async ({ page }) => {
  await signInAs(page, 'usr_admin');
  await page.goto('/admin/registrations');

  await expect(page.getByRole('heading', { name: 'Заявки поставщиков' })).toBeVisible();
});

test('форма не пускает пароль без знака препинания и с несовпадающим повтором', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await dialog.getByLabel('Название организации').fill(`Проверка ${RUN}`);
  await dialog.getByLabel('ФИО').fill('Проверкин Пров Провович');
  await dialog.getByLabel('Электронная почта').fill(`check-${RUN}@example.test`);

  // Требования видны сразу, а не выдаются по одному при отказе.
  await expect(dialog.getByText('Не короче 12 знаков')).toBeVisible();

  await dialog.getByLabel('Пароль', { exact: true }).fill('ParolBezZnaka2026');
  await dialog.getByLabel('Пароль ещё раз').fill('SovsemDrugoy2026!');
  await dialog.getByRole('button', { name: 'Зарегистрироваться' }).click();

  // Текст «знак препинания» есть и в списке требований, и в ошибке —
  // ищем именно ошибку поля.
  const errors = dialog.locator('.ant-form-item-explain-error');
  await expect(errors.filter({ hasText: /знак препинания/ })).toBeVisible();
  await expect(errors.filter({ hasText: 'Пароли не совпадают' })).toBeVisible();
  // Форма не отправлена: экрана «проверьте почту» нет.
  await expect(dialog.getByText('Проверьте почту')).toHaveCount(0);
});

test('страна выбирается из списка', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const dialog = page.locator('.ant-modal-content');
  await dialog.locator('.ant-form-item').filter({ hasText: 'Страна' })
    .locator('.ant-select-selector').click();

  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await expect(dropdown).toBeVisible();

  // Список виртуализирован: в разметке живут только видимые строки,
  // поэтому до нужной страны добираются поиском, а не прокруткой.
  await page.keyboard.type('Росс');
  // Название приходит из ICU браузера, код остаётся рядом с ним.
  await expect(dropdown.getByText('Россия · RU')).toBeVisible();

  await dropdown.getByText('Россия · RU').click();
  await expect(dialog.locator('.ant-select-selection-item')).toContainText('Россия');
});
