/**
 * Рейсы `[ТЗ 3.1]`.
 *
 * Доступные и заблокированные переходы приходят с сервера готовыми: клиент
 * не повторяет логику автомата, иначе кнопка окажется активной там, где
 * сервер ответит отказом (`SPEC § 4.4`).
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

export const flightStatusSchema = z.enum([
  'planned',
  'in_work',
  'ready_for_departure',
  'in_flight',
  'arrived',
  'completed',
  'cancelled',
  'aog',
]);

export type FlightStatus = z.infer<typeof flightStatusSchema>;

export const flightTypeSchema = z.enum([
  'charter',
  'ferry',
  'ambulance',
  'cargo',
  'technical',
]);

/**
 * Строка суточного плана (`FlightListItem` в контракте).
 *
 * Более узкий набор полей, чем у карточки: список листается постранично,
 * и считать переходы на каждую строку — это сотни лишних запросов.
 */
export const flightRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  aircraftId: z.string().nullable(),
  aircraftRegistration: z.string().nullable(),
  type: flightTypeSchema,
  depIcao: z.string(),
  arrIcao: z.string(),
  stdUtc: z.string(),
  staUtc: z.string(),
  status: flightStatusSchema,
  unconfirmedServicesCount: z.number().int(),
  marginPercent: z.string().nullable(),
  hasConflicts: z.boolean(),
  isDemo: z.boolean(),
});

export type FlightRow = z.infer<typeof flightRowSchema>;

/** Имена переходов заданы автоматом `shared/state-machines/flight.json`. */
export const flightTransitionSchema = z.enum([
  'start',
  'ready',
  'depart',
  'arrive',
  'complete',
  'cancel',
  'aog',
  'resume',
]);

export type FlightTransition = z.infer<typeof flightTransitionSchema>;

export const blockedTransitionSchema = z.object({
  transition: flightTransitionSchema,
  unmetConditions: z.array(z.string()),
});

export const flightSchema = z.object({
  id: z.string(),
  number: z.string(),
  clientId: z.string(),
  aircraftId: z.string().nullable(),
  type: flightTypeSchema,
  depIcao: z.string(),
  arrIcao: z.string(),
  stdUtc: z.string(),
  staUtc: z.string(),
  atdUtc: z.string().nullable(),
  ataUtc: z.string().nullable(),
  status: flightStatusSchema,
  statusReason: z.object({ code: z.string(), comment: z.string() }).nullable(),
  isInternational: z.boolean(),
  paxCount: z.number().int(),
  distanceNm: z.number().int(),
  blockTimeMin: z.number().int(),
  fuelPlanKg: z.number().int(),
  billingCurrency: z.string(),
  templateId: z.string().nullable(),
  remarks: z.string(),
  isDemo: z.boolean(),
  dataSource: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  availableTransitions: z.array(flightTransitionSchema),
  blockedTransitions: z.array(blockedTransitionSchema),
  crew: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      licenseNo: z.string().optional(),
    }),
  ),
  fxSnapshot: z.record(z.unknown()),
});

export type Flight = z.infer<typeof flightSchema>;

export const conflictSchema = z.object({
  kind: z.string(),
  flightId: z.string(),
  relatedFlightId: z.string().nullable(),
  message: z.string(),
  severity: z.enum(['critical', 'warning']),
});

export type ScheduleConflict = z.infer<typeof conflictSchema>;

export interface FlightFilters {
  from?: string;
  to?: string;
  status?: string;
  clientId?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

function toQuery(filters: FlightFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  query.set('page', String(filters.page ?? 1));
  query.set('perPage', String(filters.perPage ?? 50));
  return query.toString();
}

export function useFlights(filters: FlightFilters): UseQueryResult<Paged<FlightRow>> {
  const query = toQuery(filters);
  return useQuery({
    queryKey: ['flights', query],
    queryFn: ({ signal }) =>
      request(`/flights?${query}`, pagedSchema(flightRowSchema), { signal }),
    placeholderData: (previous) => previous,
  });
}

export function useFlight(id: string | undefined): UseQueryResult<Flight> {
  return useQuery({
    queryKey: ['flight', id],
    queryFn: ({ signal }) => request(`/flights/${id ?? ''}`, flightSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useScheduleConflicts(): UseQueryResult<{ data: ScheduleConflict[] }> {
  return useQuery({
    queryKey: ['flight-conflicts'],
    queryFn: ({ signal }) =>
      request('/flights/conflicts', z.object({ data: z.array(conflictSchema) }), { signal }),
    // Конфликты зависят от состояния бортов и соседних рейсов: пересчитывать
    // их на каждый переход между экранами незачем, раз в минуту достаточно.
    staleTime: 60_000,
  });
}

export const flightHistorySchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      ts: z.string(),
      actorName: z.string(),
      actorRole: z.string(),
      source: z.enum(['user', 'seed', 'system']),
      action: z.string(),
      before: z.record(z.unknown()).nullable(),
      after: z.record(z.unknown()).nullable(),
      comment: z.string().nullable(),
    }),
  ),
});

export function useFlightHistory(id: string | undefined) {
  return useQuery({
    queryKey: ['flight-history', id],
    queryFn: ({ signal }) =>
      request(`/flights/${id ?? ''}/history`, flightHistorySchema, { signal }),
    enabled: Boolean(id),
  });
}

interface CreateFlightInput {
  clientId: string;
  aircraftId?: string | null;
  type: string;
  depIcao: string;
  arrIcao: string;
  stdUtc: string;
  paxCount?: number;
  remarks?: string;
}

export function useCreateFlight() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateFlightInput) =>
      request('/flights', flightSchema, {
        method: 'POST',
        body: input,
        // Ключ генерируется на попытку, а не на рендер: иначе повтор после
        // обрыва связи считался бы новой операцией и создал второй рейс.
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-conflicts'] });
    },
  });
}

export function useFlightTransition(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { transition: string; reasonCode?: string; comment?: string }) =>
      request(`/flights/${id}/status`, flightSchema, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight', id] });
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-history', id] });
    },
  });
}

export function useUpdateFlight(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      request(`/flights/${id}`, flightSchema, { method: 'PATCH', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight', id] });
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
    },
  });
}

export const flightRequestSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  depIcao: z.string(),
  arrIcao: z.string(),
  requestedStdUtc: z.string(),
  paxCount: z.number().int(),
  comment: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdFlightId: z.string().nullable(),
  rejectionReason: z.string(),
  createdAt: z.string(),
});

export type FlightRequest = z.infer<typeof flightRequestSchema>;

export function useFlightRequests(status?: string): UseQueryResult<Paged<FlightRequest>> {
  const query = new URLSearchParams({ perPage: '100' });
  if (status) query.set('status', status);

  return useQuery({
    queryKey: ['flight-requests', status ?? ''],
    queryFn: ({ signal }) =>
      request(`/flight-requests?${query.toString()}`, pagedSchema(flightRequestSchema), {
        signal,
      }),
  });
}

export function useApproveRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/flight-requests/${id}/approve`, flightSchema, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
    },
  });
}

export function useRejectRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      request(`/flight-requests/${input.id}/reject`, flightRequestSchema, {
        method: 'POST',
        body: { reason: input.reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-requests'] });
    },
  });
}
