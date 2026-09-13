/** Курсы валют `[ТЗ 3.4.1]`. */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { request } from './client';

export const fxSnapshotSchema = z.object({
  date: z.string(),
  base: z.string(),
  rates: z.record(z.string()),
  policy: z.enum(['document_date', 'order_date']),
  source: z.enum(['synthetic', 'user', 'imported', 'live']).optional(),
  staleSince: z.string().nullable().optional(),
  history: z
    .array(z.object({ date: z.string(), rates: z.record(z.string()) }))
    .optional(),
});

export type FxSnapshot = z.infer<typeof fxSnapshotSchema>;

/**
 * Курсы на сегодня и динамика за период.
 *
 * Обновляются раз в час: ЦБ публикует курс раз в сутки, чаще спрашивать
 * незачем, а реже — значит показывать вчерашний после публикации нового.
 *
 * Текущий момент передаётся снаружи: к часам браузера обращается только
 * `useClock()` (`CLAUDE.md § 3` п. 2).
 */
export function useFxRates(now: Date, days = 45): UseQueryResult<FxSnapshot> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

  return useQuery({
    queryKey: ['fx-rates', since],
    queryFn: ({ signal }) => request(`/fx-rates?from=${since}`, fxSnapshotSchema, { signal }),
    staleTime: 60 * 60 * 1000,
  });
}
