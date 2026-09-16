/**
 * Слоты в координируемых аэропортах `[ТЗ 3.1.1, 3.2.1, 4.2]` (ADR-026).
 *
 * Подключения к слот-координации не существует: это инструмент подготовки
 * переписки. Черновик сообщения собирает сервер, отправляет его диспетчер
 * сам, а ответ координатора применяется отдельным действием.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';

export const slotStatusSchema = z.enum(['requested', 'confirmed', 'rejected', 'cancelled']);
export const slotKindSchema = z.enum(['arrival', 'departure']);

export type SlotStatus = z.infer<typeof slotStatusSchema>;
export type SlotKind = z.infer<typeof slotKindSchema>;

export const slotSchema = z.object({
  id: z.string(),
  airportIcao: z.string(),
  flightId: z.string(),
  kind: slotKindSchema,
  requestedTimeUtc: z.string().nullable().default(null),
  confirmedTimeUtc: z.string().nullable().default(null),
  status: slotStatusSchema,
  messageRef: z.string().nullable().default(null),
  comment: z.string().nullable().default(null),
});

export type SlotRow = z.infer<typeof slotSchema>;

export function useSlots(params: {
  flightId?: string;
  airportIcao?: string;
}): UseQueryResult<Paged<SlotRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (params.flightId) query.set('flightId', params.flightId);
  if (params.airportIcao) query.set('airportIcao', params.airportIcao);

  return useQuery({
    queryKey: ['slots', query.toString()],
    queryFn: ({ signal }) =>
      request(`/slots?${query.toString()}`, pagedSchema(slotSchema), { signal }),
  });
}

export interface CreateSlotInput {
  flightId: string;
  airportIcao: string;
  kind: SlotKind;
  requestedTimeUtc: string;
}

export function useCreateSlot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateSlotInput) =>
      request('/slots', slotSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

const slotMessageSchema = z.object({ messageRef: z.string(), text: z.string() });

export type SlotMessage = z.infer<typeof slotMessageSchema>;

/**
 * Черновик сообщения SCR.
 *
 * Собирает сервер: формат сообщения — часть системы, а не оформление
 * экрана, и собирать его в браузере значило бы держать формат в двух местах.
 */
export function useBuildScr() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/slots/${id}/scr`, slotMessageSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      // Слоту присвоен номер сообщения — он виден в реестре.
      void queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

export function useApplySlotAnswer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      text?: string;
      status?: SlotStatus;
      confirmedTimeUtc?: string | null;
    }) =>
      request(`/slots/${input.id}/apply`, slotSchema, {
        method: 'POST',
        body: {
          text: input.text ?? '',
          ...(input.status ? { status: input.status } : {}),
          ...(input.confirmedTimeUtc ? { confirmedTimeUtc: input.confirmedTimeUtc } : {}),
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slots'] });
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
    },
  });
}
