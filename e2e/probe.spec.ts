import { test } from '@playwright/test';

test('probe flight card', async ({ page }) => {
  page.on('console', (m) => { console.log('[console.' + m.type() + ']', m.text()); });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message, '\n', e.stack?.slice(0, 600)); });
  await page.goto('/flights/flt_002', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
});
