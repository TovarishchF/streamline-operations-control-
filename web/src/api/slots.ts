/** Реестр слотов `[ТЗ 3.1.1]` (ADR-026). */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { pagedSchema, type Paged } from './catalog';
import { request } from './client';

export const slotSchema = z.object({
  id: z.string(),
  airportIcao: z.string(),
  flightId: z.string(),
  kind: z.enum(['arrival', 'departure']),
  requestedTimeUtc: z.string(),
  confirmedTimeUtc: z.string().nullable(),
  status: z.enum(['requested', 'confirmed', 'rejected', 'cancelled']),
  messageRef: z.string(),
});

export type Slot = z.infer<typeof slotSchema>;

/**
 * Слоты рейса. Без указания рейса — весь реестр.
 *
 * Подключения к системам слот-координации не существует: координаторы
 * работают сообщениями по почте (`INTEGRATIONS § 5.1`). Здесь ведётся реестр.
 */
export function useSlots(flightId?: string): UseQueryResult<Paged<Slot>> {
  const query = new URLSearchParams({ perPage: '100' });
  if (flightId) query.set('flightId', flightId);

  return useQuery({
    queryKey: ['slots', flightId ?? ''],
    queryFn: ({ signal }) =>
      request(`/slots?${query.toString()}`, pagedSchema(slotSchema), { signal }),
  });
}
