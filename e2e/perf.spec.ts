import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { Api } from './helpers/scenario';
import { ACCOUNTS, signInAs } from './helpers/session';

/**
 * Замер открытия карточки рейса на полном наборе генератора (ТЗ 4.4,
 * приёмка M10). Метод — ADR-017:
 * - первая загрузка — от навигации браузера до largest-contentful-paint,
 *   но не раньше отрисовки данных рейса;
 * - переход внутри приложения — от нажатия на номер рейса в плане
 *   до отрисовки карточки с данными.
 *
 * Сырые замеры, перцентили, дата и версия кода пишутся в `artifacts/perf/`
 * как есть (`CLAUDE.md § 4`): протокол — вывод инструмента, а не текст.
 */

const NORM_MS = 2000;
const CARDS = 20;
const OUT = resolve(process.cwd(), '../artifacts/perf');

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** Время первой загрузки: LCP, но не раньше кадра с данными рейса. */
async function initialLoad(page: Page, id: string, number: string): Promise<number> {
  await page.goto(`/flights/${id}`);
  await expect(page.locator('h4', { hasText: number })).toBeVisible({ timeout: 30_000 });
  return page.evaluate(
    () =>
      new Promise<number>((done) => {
        requestAnimationFrame(() => {
          const painted = performance.now();
          let lcp = 0;
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) lcp = Math.max(lcp, entry.startTime);
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            lcp = 0;
          }
          setTimeout(() => {
            done(Math.max(lcp, painted));
          }, 300);
        });
      }),
  );
}

test('карточка рейса открывается в норматив ТЗ 4.4', async ({ page, playwright }, testInfo) => {
  test.setTimeout(600_000);
  const request = await playwright.request.newContext();
  const api = await Api.as(request, ACCOUNTS['usr_disp1'] ?? 'karpov');
  const list = await api.get<{ data: { id: string; number: string }[]; meta: { total: number } }>(
    `/flights?perPage=${String(CARDS)}&ordering=-stdUtc`,
  );
  const flights = list.data;
  expect(flights.length, 'в наборе нет рейсов: make seed-sample').toBeGreaterThan(0);

  await signInAs(page, 'usr_disp1');
  const initial: number[] = [];
  for (const flight of flights) {
    initial.push(await initialLoad(page, flight.id, flight.number));
  }

  const navigation: number[] = [];
  for (const flight of flights) {
    await page.goto(`/schedule`);
    await page.locator('.ant-segmented-item', { hasText: 'Таблица' }).click();
    await page.getByPlaceholder('Номер, клиент, борт, аэропорт').fill(flight.number);
    const link = page.locator('.ant-table-row a', { hasText: flight.number }).first();
    await expect(link).toBeVisible();
    const started = Date.now();
    await link.click();
    await expect(page.locator('h4', { hasText: flight.number })).toBeVisible({ timeout: 30_000 });
    navigation.push(Date.now() - started);
  }
  await request.dispose();

  const report = {
    metric: 'flight_card',
    normMs: NORM_MS,
    method: 'ADR-017: первая загрузка — до LCP и отрисовки данных; переход — от нажатия до отрисовки данных',
    measuredAt: new Date().toISOString(),
    // `-dirty` — замер сделан на коде, которого нет в коммите
    commit: execSync('git describe --always --dirty').toString().trim(),
    project: testInfo.project.name,
    environment: 'стенд разработки: vite preview + Django runserver, набор генератора',
    flightsInDataset: list.meta.total,
    initialLoad: { samples: initial.map(Math.round), p50: Math.round(percentile(initial, 50)), p95: Math.round(percentile(initial, 95)) },
    navigation: { samples: navigation, p50: percentile(navigation, 50), p95: percentile(navigation, 95) },
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, `m10-flight-card-${report.measuredAt.replace(/[:.]/g, '-')}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  expect(report.initialLoad.p95, 'первая загрузка карточки, p95').toBeLessThanOrEqual(NORM_MS);
  expect(report.navigation.p95, 'переход к карточке, p95').toBeLessThanOrEqual(NORM_MS);
});
