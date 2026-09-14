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
 *
 * Про вложения. Подписанная ссылка на загрузку выдаётся для адреса,
 * по которому к хранилищу обращается браузер (`S3_PUBLIC_ENDPOINT`):
 * подпись SigV4 покрывает `Host`. Для браузера на машине разработчика
 * это `http://localhost:9000`, для браузера внутри сети Docker —
 * `http://minio:9000`. Прогон испытаний поднимает сервер со вторым
 * значением:
 *
 *     docker compose run --rm -e S3_PUBLIC_ENDPOINT=http://minio:9000 ...
 *
 * Оставить одно значение на оба случая нельзя: `localhost` внутри
 * контейнера указывает на сам контейнер.
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
