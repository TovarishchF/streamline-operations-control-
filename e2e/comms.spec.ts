import { expect, test, type Locator, type Page } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Кнопки экрана коммуникаций `[ТЗ 3.5.1, 3.5.2, 3.2.2]`.
 *
 * Проверяется работа за кнопкой, а не её нажимаемость: «Повторить» меняет
 * состояние сообщения на сервере, `eml` открывает подписанную ссылку
 * на настоящий файл письма, «Применить» двигает заявку, а «Обработать
 * вручную» открывает разбор письма, которое система не опознала.
 *
 * Отдельно проверяется, что бейдж канала показывает фактический режим:
 * заглушка не должна выглядеть как отправка наружу (`CLAUDE.md § 4`).
 */

function dialog(page: Page): Locator {
  return page.locator('.ant-modal-content');
}

/** Подтверждение в всплывающем окне Ant Design. */
async function confirm(page: Page): Promise<void> {
  await page
    .locator('.ant-popover-buttons, .ant-popconfirm-buttons')
    .getByRole('button', { name: 'Да' })
    .click();
}

/**
 * Переключатель Ant Design `Segmented`.
 *
 * Сам радиопереключатель скрыт, видима только подпись, поэтому нажатие
 * по роли `radio` не проходит.
 */
async function pickSegment(page: Page, label: string): Promise<void> {
  await page.locator('.ant-segmented-item', { hasText: label }).click();
}

test.describe('Коммуникации', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'usr_disp1');
  });

  test('исходящие показывают фактический режим канала', async ({ page }) => {
    const listed = page.waitForResponse(
      (response) => response.url().includes('/api/v1/outbox?') && response.status() === 200,
    );
    await page.goto('/communications/outbox', { waitUntil: 'networkidle' });
    const body = (await (await listed).json()) as { data: { channelMode: string }[] };

    expect(body.data.length, 'на стенде нет исходящих сообщений').toBeGreaterThan(0);
    // Подключение в режиме заглушки — так и написано в таблице
    expect(body.data.every((item) => item.channelMode === 'stub')).toBe(true);
    await expect(page.getByRole('cell', { name: 'stub' }).first()).toBeVisible();
  });

  test('кнопка «Повторить» отправляет сообщение с ошибкой', async ({ page }) => {
    await page.goto('/communications/outbox', { waitUntil: 'networkidle' });

    // Берётся первая строка с кнопкой повтора: она есть у неотправленных —
    // и у тех, что в очереди, и у тех, что с ошибкой. Отбирать по одному
    // состоянию значило бы зависеть от того, что осталось на стенде
    // от предыдущего прогона.
    const row = page
      .locator('.ant-table-row')
      .filter({ has: page.getByRole('button', { name: 'Повторить' }) })
      .first();
    await expect(row, 'на стенде нет неотправленных сообщений').toBeVisible();

    const retried = page.waitForResponse(
      (response) =>
        response.url().includes('/retry') && response.request().method() === 'POST',
    );
    await row.getByRole('button', { name: 'Повторить' }).click();
    await confirm(page);

    const response = await retried;
    expect(response.status(), 'сервер отказал в повторе').toBe(200);

    const message = (await response.json()) as { status: string; attempts: number };
    expect(message.status).toBe('sent');
    // Счётчик попыток сброшен: человек нажал кнопку осознанно
    expect(message.attempts).toBe(1);
  });

  test('кнопка eml отдаёт подписанную ссылку на письмо', async ({ page }) => {
    await page.goto('/communications/outbox', { waitUntil: 'networkidle' });

    // Отправленное письмо: у него есть файл
    await pickSegment(page, 'Отправлено');
    await page.waitForResponse(
      (response) => response.url().includes('status=sent') && response.status() === 200,
    );

    const link = page.locator('.ant-table-row').first().getByRole('link', { name: 'eml' });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    expect(href, 'ссылки на письмо нет').toContain('.eml');
    expect(href).toContain('X-Amz-Signature');
  });

  test('кнопка «Применить» двигает заявку по входящему письму', async ({ page }) => {
    const listed = page.waitForResponse(
      (response) => response.url().includes('/api/v1/inbox?') && response.status() === 200,
    );
    await page.goto('/communications/inbox', { waitUntil: 'networkidle' });
    const body = (await (await listed).json()) as {
      data: { recognized: boolean; appliedAt: string | null }[];
    };

    const pending = body.data.filter((item) => item.recognized && item.appliedAt === null);
    expect(pending.length, 'на стенде нет опознанных входящих').toBeGreaterThan(0);

    const row = page
      .locator('.ant-table-row')
      .filter({ hasText: 'Распознано' })
      .filter({ has: page.getByRole('button', { name: 'Применить' }) })
      .first();

    const applied = page.waitForResponse(
      (response) => response.url().includes('/apply') && response.request().method() === 'POST',
    );
    await row.getByRole('button', { name: 'Применить' }).click();
    await confirm(page);

    const response = await applied;
    expect(response.status(), 'сервер отказал в применении').toBe(200);
    expect(((await response.json()) as { appliedAt: string | null }).appliedAt).not.toBeNull();
  });

  test('нераспознанное письмо разбирается вручную', async ({ page }) => {
    await page.goto('/communications/inbox', { waitUntil: 'networkidle' });

    await page.getByText('Только нераспознанные').click();
    await page.waitForResponse(
      (response) =>
        response.url().includes('unrecognizedOnly=true') && response.status() === 200,
    );

    const row = page.locator('.ant-table-row').first();
    const hasUnrecognized = await row.isVisible();
    test.skip(!hasUnrecognized, 'на стенде нет нераспознанных писем');

    await row.getByRole('button', { name: 'Разобрать' }).click();

    const form = dialog(page);
    await expect(form).toBeVisible();
    // Окно объясняет, что это штатный сценарий, а не сбой
    await expect(form.getByText('штатный сценарий')).toBeVisible();
    await expect(form.getByLabel('Заявка на услугу')).toBeVisible();
    await expect(form.getByLabel('Действие')).toBeVisible();
  });

  test('шаблон сообщения собирается на настоящем рейсе', async ({ page }) => {
    await page.goto('/communications/templates', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer).toBeVisible();

    const rendered = page.waitForResponse(
      (response) =>
        response.url().includes('/preview') && response.request().method() === 'POST',
    );
    await drawer.locator('.ant-select-selector').first().click();
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .last()
      .locator('.ant-select-item-option')
      .first()
      .click();

    const response = await rendered;
    expect(response.status(), 'сервер не собрал предпросмотр').toBe(200);

    const preview = (await response.json()) as { subject: string; body: string };
    expect(preview.subject.length).toBeGreaterThan(0);
    // Собранный текст виден на экране, а не только в ответе
    // Именно заголовок письма, а не совпадение в теле
    await expect(drawer.getByText(preview.subject, { exact: true })).toBeVisible();
  });

  test('колокольчик показывает уведомления с сервера', async ({ page }) => {
    const listed = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/notifications?') && response.status() === 200,
    );
    await page.goto('/schedule', { waitUntil: 'networkidle' });
    await listed;

    await page.getByRole('button', { name: 'Уведомления' }).click();
    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.ant-list-item').first()).toBeVisible();
  });
});
