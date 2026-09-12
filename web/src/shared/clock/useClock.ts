import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * Единый источник времени на клиенте.
 *
 * `CLAUDE.md § 3` п. 2: `new Date()` в доменном коде запрещён (правило включено
 * в eslint.config.js). Время приходит **от сервера**: на демонстрационном стенде
 * оно может быть смещено (ADR-014), и системные часы браузера об этом не знают.
 *
 * Между запросами значение экстраполируется тиком в одну секунду.
 */

interface ClockState {
  nowUtc: Date | null;
  shifted: boolean;
  scale: number;
  syncedAt: number | null;
  sync: (serverNowUtc: string, shifted: boolean, scale: number) => void;
  tick: () => void;
}

export const useClockStore = create<ClockState>((set, get) => ({
  nowUtc: null,
  shifted: false,
  scale: 1,
  syncedAt: null,

  sync: (serverNowUtc, shifted, scale) => {
    set({
      nowUtc: new Date(serverNowUtc),
      shifted,
      scale,
      syncedAt: performance.now(),
    });
  },

  tick: () => {
    const { nowUtc, scale } = get();
    if (!nowUtc) return;
    set({ nowUtc: new Date(nowUtc.getTime() + 1000 * scale) });
  },
}));

/** Тик часов. Один на приложение — вешается в корневом компоненте. */
export function useClockTicker(): void {
  const tick = useClockStore((state) => state.tick);
  useEffect(() => {
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [tick]);
}

/**
 * Текущее время. Возвращает `null`, пока не выполнена синхронизация с сервером:
 * лучше показать «—», чем неверное время.
 */
export function useClock(): { nowUtc: Date | null; shifted: boolean } {
  const nowUtc = useClockStore((state) => state.nowUtc);
  const shifted = useClockStore((state) => state.shifted);
  return { nowUtc, shifted };
}

/** Форматирование с обязательной подписью зоны (`CLAUDE.md § 10`). */
export function formatUtc(value: Date | null): string {
  if (!value) return '—';
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

export function useIsClockReady(): boolean {
  const [ready, setReady] = useState(false);
  const nowUtc = useClockStore((state) => state.nowUtc);
  useEffect(() => {
    if (nowUtc) setReady(true);
  }, [nowUtc]);
  return ready;
}
