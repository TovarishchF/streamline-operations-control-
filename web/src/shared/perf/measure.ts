/**
 * Клиентские замеры нормативов ТЗ 4.4 (ADR-017).
 *
 * Норматив «карточка рейса открывается за 2 секунды» заказчик понимает как
 * время до отрисовки экрана, а не длительность одного запроса. Поэтому:
 * - при первой загрузке — время от навигации до `largest-contentful-paint`;
 * - при переходе внутри приложения — от монтирования экрана до отрисовки
 *   его данных (LCP при мягкой навигации браузер не публикует).
 *
 * Замеры копятся и уходят пачкой в `POST /performance/samples`; на
 * `/admin/performance` сервер считает по ним перцентили. Ошибка отправки
 * не трогает интерфейс: замер — наблюдение, а не часть операции.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { z } from 'zod';

import { request } from '@/api/client';

export type MetricName = 'flight_card' | 'margin_calc';

interface Sample {
  name: MetricName;
  durationMs: number;
  route?: string;
  kind?: 'initial_load' | 'navigation';
}

const BATCH_LIMIT = 50;
const FLUSH_INTERVAL_MS = 15_000;
/** LCP публикуется с задержкой: значение читается после отрисовки данных. */
const LCP_SETTLE_MS = 1_000;

const queue: Sample[] = [];
let navigations = 0;
let latestLcpMs: number | null = null;
let started = false;

function observeLcp(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) latestLcpMs = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // Браузер без LCP: первая загрузка меряется до отрисовки данных.
  }
}

async function flush(): Promise<void> {
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_LIMIT);
    try {
      await request('/performance/samples', z.object({ accepted: z.number().int() }), {
        method: 'POST',
        body: { samples: batch },
      });
    } catch {
      return;
    }
  }
}

/** Запуск наблюдения: один раз на приложение. */
export function startPerformanceReporting(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  observeLcp();
  window.setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}

export function record(sample: Sample): void {
  queue.push({ ...sample, durationMs: Math.max(0, Math.round(sample.durationMs)) });
}

/** Счётчик переходов внутри приложения: первый экран сессии — «первая загрузка». */
export function useNavigationTracker(): void {
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    navigations += 1;
  }, [location.pathname]);
}

/**
 * Замер экрана: от монтирования (или навигации браузера при первой загрузке)
 * до кадра, в котором отрисованы его данные. Пишется один раз на монтирование.
 */
export function useScreenTiming(name: MetricName, ready: boolean): void {
  const location = useLocation();
  const [mountedAt] = useState(() => performance.now());
  const [initial] = useState(() => navigations === 0);
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const route = location.pathname;
    // Два кадра: первый — React применил изменения, второй — браузер их нарисовал.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const paintedAt = performance.now();
        if (!initial) {
          record({ name, durationMs: paintedAt - mountedAt, route, kind: 'navigation' });
          return;
        }
        window.setTimeout(() => {
          record({
            name,
            durationMs: Math.max(latestLcpMs ?? 0, paintedAt),
            route,
            kind: 'initial_load',
          });
        }, LCP_SETTLE_MS);
      });
    });
  }, [ready, name, mountedAt, initial, location.pathname]);
}

/** Замер расчёта: время запроса, обёрнутое вокруг обещания. */
export async function timed<T>(name: MetricName, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await run();
  record({ name, durationMs: performance.now() - startedAt, route: window.location.pathname });
  return result;
}
