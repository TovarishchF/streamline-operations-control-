/** Системные эндпоинты: здоровье и время сервера. */
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { request } from './client';
import { useClockStore } from '@/shared/clock/useClock';
import { useEffect } from 'react';

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  commit: z.string(),
  checks: z.record(
    z.object({
      status: z.enum(['ok', 'down']),
      latencyMs: z.number().int(),
    }),
  ),
});

export type Health = z.infer<typeof healthSchema>;

export const clockSchema = z.object({
  nowUtc: z.string(),
  shifted: z.boolean(),
  scale: z.number().int(),
});

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => request('/health', healthSchema, { signal }),
    refetchInterval: 30_000,
    retry: 1,
  });
}

/**
 * Синхронизация часов с сервером.
 *
 * Повторяется раз в минуту: между синхронизациями значение экстраполируется,
 * но дрейф браузерного таймера накапливается, а на стенде время ещё и может
 * быть перемотано администратором (ADR-014).
 */
export function useClockSync(): void {
  const sync = useClockStore((state) => state.sync);

  const query = useQuery({
    queryKey: ['clock'],
    queryFn: ({ signal }) => request('/clock', clockSchema, { signal }),
    refetchInterval: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (query.data) {
      sync(query.data.nowUtc, query.data.shifted, query.data.scale);
    }
  }, [query.data, sync]);
}
