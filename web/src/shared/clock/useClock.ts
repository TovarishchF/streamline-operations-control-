import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Единый источник времени на клиенте.
 *
 * `CLAUDE.md § 3` п. 2: текущее время берётся из `useClock()`, а не из часов
 * браузера. Источник истины — **сервер**: на демонстрационном стенде время
 * может быть смещено (ADR-014), и часы браузера об этом не знают.
 *
 * До первого ответа сервера часы идут от браузера и помечены `synced: false`.
 * Интерфейс, которому нечего показать, бесполезен; но подмена не скрывается —
 * признак виден в шапке и уходит в `/admin/performance`. Как только сервер
 * ответил, значение заменяется серверным и `synced` становится `true`.
 *
 * Между запросами значение экстраполируется тиком в одну секунду.
 */

interface ClockState {
  nowUtc: Date;
  /** Ответил ли сервер. Пока `false`, время взято из часов браузера. */
  synced: boolean;
  shifted: boolean;
  scale: number;
  sync: (serverNowUtc: string, shifted: boolean, scale: number) => void;
  /** Сдвиг на демонстрационном стенде до появления сервера (панель часов). */
  shiftBy: (milliseconds: number) => void;
  setScale: (scale: number) => void;
  tick: () => void;
}

export const useClockStore = create<ClockState>((set, get) => ({
  // Единственное место, где допустимо обратиться к часам браузера: это
  // источник времени до первого ответа сервера, и он помечен synced: false.
  nowUtc: new Date(),
  synced: false,
  shifted: false,
  scale: 1,

  sync: (serverNowUtc, shifted, scale) => {
    set({ nowUtc: new Date(serverNowUtc), synced: true, shifted, scale });
  },

  shiftBy: (milliseconds) => {
    set((state) => ({
      nowUtc: new Date(state.nowUtc.getTime() + milliseconds),
      shifted: true,
    }));
  },

  setScale: (scale) => {
    set({ scale, shifted: scale !== 1 });
  },

  tick: () => {
    const { nowUtc, scale } = get();
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

export function useClock(): { nowUtc: Date; synced: boolean; shifted: boolean } {
  const nowUtc = useClockStore((state) => state.nowUtc);
  const synced = useClockStore((state) => state.synced);
  const shifted = useClockStore((state) => state.shifted);
  return { nowUtc, synced, shifted };
}

/** Форматирование с обязательной подписью зоны (`CLAUDE.md § 10`). */
export function formatUtc(value: Date | null): string {
  if (!value) return '—';
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}
