import { defineConfig, devices } from '@playwright/test';

/**
 * Конфигурация сквозных испытаний.
 *
 * Съёмка экранов, проверки операций, сквозной сценарий `SPEC.md § 12`
 * (`scenario.spec.ts`) и замер карточки рейса (`perf.spec.ts`).
 * Веб-клиент поднимается из собранной статики — так же, как он будет
 * работать за nginx в бою.
 */
export default defineConfig({
  testDir: '.',
  // Снимки для руководства снимаются с установки для показа: manuals.config.ts.
  testIgnore: /manuals\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: '../artifacts/e2e/report', open: 'never' }]],

  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ru-RU',
    timezoneId: 'UTC',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
    {
      // Адаптив от 360 px — приёмочный критерий M10, проверяется с M2.
      // Операции, сквозной сценарий и замер карточки проверяются один раз
      // в настольном профиле: поведение кнопок от ширины экрана не зависит,
      // а прогон вдвое дольше.
      name: 'mobile',
      testIgnore: /(operations|scenario|perf|manuals)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 800 } },
    },
  ],

  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    cwd: '../web',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
