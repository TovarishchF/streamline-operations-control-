import { defineConfig, devices } from '@playwright/test';

/**
 * Прогон сквозных испытаний в контейнере Playwright.
 *
 * Node.js на машине разработчика может не быть, а браузеры Playwright
 * не ставятся в образ веб-клиента: он на Alpine, а браузеры собраны
 * под glibc. Контейнер с официальным образом решает и то, и другое.
 *
 * Приложение при этом берётся **работающее**, из поднятого окружения:
 * испытание проверяет тот же dev-сервер и тот же API, что видит
 * разработчик, а не отдельную сборку.
 */
const HOST = process.env['SOC_HOST'] ?? 'host.docker.internal';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../artifacts/e2e/registries.json' }]],

  use: {
    baseURL: `http://${HOST}:5173`,
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
  ],
});
