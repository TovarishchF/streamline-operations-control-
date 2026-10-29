import { defineConfig, devices } from '@playwright/test';

/**
 * Снимки экранов для руководства пользователя (`docs/manuals/`).
 *
 * Снимаются с установки для показа (docker-compose.sample.yml), а не со стенда
 * разработки: в руководстве должен быть тот же набор данных, что увидит
 * заказчик. Адрес — SOC_SAMPLE_URL, по умолчанию http://localhost:8080.
 *
 *   npx playwright test -c manuals.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /manuals\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['SOC_SAMPLE_URL'] ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  },
});
