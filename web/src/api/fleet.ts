/** Парк воздушных судов `[ТЗ 3.1.3]`. */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { aircraftTypeSchema, pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';
import type { Aircraft, AircraftStatus } from './types';

export const aircraftApprovalSchema = z.object({
  kind: z.enum(['ETOPS', 'RVSM', 'MNPS', 'CAT_II', 'CAT_III', 'RNP', 'other']),
  number: z.string().optional(),
  validFrom: z.string(),
  validTo: z.string(),
});

export const aircraftSchema = z.object({
  id: z.string(),
  registration: z.string(),
  typeId: z.string(),
  type: aircraftTypeSchema.optional(),
  operatorId: z.string().nullable(),
  status: z.enum(['serviceable', 'maintenance', 'aog']),
  homeBaseIcao: z.string(),
  approvals: z.array(aircraftApprovalSchema).optional(),
  notes: z.string().nullable(),
}) satisfies z.ZodType<Aircraft>;

export function useFleet(status?: AircraftStatus): UseQueryResult<Paged<Aircraft>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (status) query.set('status', status);

  return useQuery({
    queryKey: ['fleet', status ?? ''],
    queryFn: ({ signal }) =>
      request(`/fleet?${query.toString()}`, pagedSchema(aircraftSchema), { signal }),
  });
}

/**
 * Изменение состояния борта.
 *
 * После успеха выборка парка помечается устаревшей: список и карточка
 * должны показать новое состояние, а не то, что было до нажатия.
 */
export function useUpdateAircraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; status?: AircraftStatus; notes?: string }) =>
      request(`/fleet/${input.id}`, aircraftSchema, {
        method: 'PATCH',
        body: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    },
  });
}

export interface CreateAircraftInput {
  registration: string;
  typeId: string;
  operatorId?: string | null;
  homeBaseIcao: string;
  status: AircraftStatus;
  notes: string;
  approvals: {
    kind: 'ETOPS' | 'RVSM' | 'MNPS' | 'CAT_II' | 'CAT_III' | 'RNP' | 'other';
    number: string;
    validFrom: string;
    validTo: string;
  }[];
}

/** Постановка борта в парк `[ТЗ 3.1.3]`. */
export function useCreateAircraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateAircraftInput) =>
      request('/fleet', aircraftSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      // Новый борт обязан появиться в выборе при создании рейса
      void queryClient.invalidateQueries({ queryKey: ['flight-conflicts'] });
    },
  });
}
