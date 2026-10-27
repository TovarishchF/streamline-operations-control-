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

import { auditEntrySchema, type AuditEntryRow } from './admin';
import { pagedSchema, type Paged } from './catalog';
import { ApiError, newIdempotencyKey, request } from './client';

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
  isGenerated: z.boolean(),
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
  isGenerated: z.boolean(),
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

/** `ScheduleConflict` из контракта. */
export const conflictSchema = z.object({
  kind: z.enum([
    'overlap',
    'turnaround',
    'aircraft_unserviceable',
    'expired_approval',
    'missing_slot',
  ]),
  flightId: z.string(),
  relatedFlightId: z.string().nullable(),
  aircraftId: z.string().nullable().optional(),
  message: z.string(),
  severity: z.enum(['blocking', 'warning']),
});

export type ScheduleConflict = z.infer<typeof conflictSchema>;

/** Отбор суточного плана — параметры `GET /flights` (`SPEC.md § 4.2`). */
export interface FlightFilters {
  from?: string;
  to?: string;
  status?: string;
  clientId?: string;
  aircraftId?: string;
  aircraftTypeId?: string;
  type?: string;
  airport?: string;
  hasUnconfirmedServices?: boolean;
  marginBelowPercent?: string;
  ordering?: string;
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

export function useFlights(
  filters: FlightFilters,
  enabled = true,
): UseQueryResult<Paged<FlightRow>> {
  const query = toQuery(filters);
  return useQuery({
    queryKey: ['flights', query],
    queryFn: ({ signal }) =>
      request(`/flights?${query}`, pagedSchema(flightRowSchema), { signal }),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useFlight(id: string | undefined): UseQueryResult<Flight> {
  return useQuery({
    queryKey: ['flight', id],
    queryFn: ({ signal }) => request(`/flights/${id ?? ''}`, flightSchema, { signal }),
    enabled: Boolean(id),
  });
}

/**
 * Конфликты расписания за период вылета.
 *
 * Без периода сервер считает горизонт планирования — месяц вперёд.
 * Карточке рейса нужен один рейс: она спрашивает узкое окно вокруг его
 * вылета, а не весь месяц ради одной строки.
 */
export function useScheduleConflicts(
  range?: { from: string; to: string },
): UseQueryResult<{ data: ScheduleConflict[] }> {
  const query = range ? `?${new URLSearchParams(range).toString()}` : '';
  return useQuery({
    queryKey: ['flight-conflicts', query],
    queryFn: ({ signal }) =>
      request(`/flights/conflicts${query}`, z.object({ data: z.array(conflictSchema) }), {
        signal,
      }),
    // Конфликты зависят от состояния бортов и соседних рейсов: пересчитывать
    // их на каждый переход между экранами незачем, раз в минуту достаточно.
    staleTime: 60_000,
  });
}

/**
 * Журнал по рейсу: сам рейс, его заявки и документы (`PagedResponse`).
 *
 * Берётся первая страница наибольшего размера: карточке нужен журнал
 * целиком, а у рейса он редко превышает двести записей.
 */
export function useFlightHistory(id: string | undefined): UseQueryResult<Paged<AuditEntryRow>> {
  return useQuery({
    queryKey: ['flight-history', id],
    queryFn: ({ signal }) =>
      request(`/flights/${id ?? ''}/history?perPage=200`, pagedSchema(auditEntrySchema), {
        signal,
      }),
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

/** `FlightTransitionRequest` из контракта. */
export interface FlightTransitionInput {
  transition: FlightTransition;
  reasonCode?: string;
  comment?: string;
  /** Явный отказ от счёта при завершении, требует причины в `comment`. */
  completeWithoutInvoice?: boolean;
}

export function useFlightTransition(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: FlightTransitionInput) =>
      request(`/flights/${id}/status`, flightSchema, {
        method: 'POST',
        body: input,
        // Контракт требует ключ (ADR-018): повтор перехода при обрыве связи
        // не должен выполнить его дважды.
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (flight) => {
      queryClient.setQueryData(['flight', id], flight);
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-history', id] });
      void queryClient.invalidateQueries({ queryKey: ['flight-orders', id] });
      void queryClient.invalidateQueries({ queryKey: ['flight-margin', id] });
    },
  });
}

/**
 * Переход статуса одного рейса, без привязки к хуку.
 *
 * Нужен массовым действиям: хук заводится на идентификатор, а пачка
 * обходит рейсы по очереди — у каждого свой автомат и свои условия,
 * и рейс, который не может перейти, не должен отменять переход остальных.
 */
export async function transitionFlight(
  input: FlightTransitionInput & { id: string },
): Promise<Flight> {
  const { id, ...body } = input;
  return request(`/flights/${id}/status`, flightSchema, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

/**
 * Выгрузка суточного плана в XLSX `[ТЗ 3.1.1]`.
 *
 * Отбор передаётся тот же, что у списка: файл обязан совпадать с таблицей
 * на экране. Собирает файл сервер и отдаёт подписанную ссылку.
 */
export function useExportSchedule() {
  return useMutation({
    mutationFn: (filters: FlightFilters) =>
      request(`/flights/export?${toQuery(filters)}`, exportTicketSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
  });
}

const exportTicketSchema = z.object({
  taskId: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  downloadUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

/** Правка рейса — форма и планшет (`SPEC.md § 4.1`). */
export interface FlightUpdateInput {
  aircraftId?: string | null;
  depIcao?: string;
  arrIcao?: string;
  stdUtc?: string;
  staUtc?: string;
  paxCount?: number;
  remarks?: string;
  /** Причина, с которой подтверждён конфликт, появившийся от правки. */
  conflictOverrideReason?: string;
}

/**
 * Изменение рейса одним запросом, без привязки к хуку: планшет двигает
 * разные рейсы, и хук на идентификатор ему не подходит.
 *
 * Новый конфликт без причины сервер отклоняет 409 SCHEDULE_CONFLICT
 * со списком конфликтов — его разбирает `conflictsFromError`.
 */
export async function updateFlight(id: string, input: FlightUpdateInput): Promise<Flight> {
  return request(`/flights/${id}`, flightSchema, { method: 'PATCH', body: input });
}

export function conflictsFromError(error: unknown): { kind: string; message: string }[] {
  if (!(error instanceof ApiError) || error.code !== 'SCHEDULE_CONFLICT') return [];
  const raw = error.details['conflicts'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is { kind: string; message: string } =>
      typeof item === 'object' && item !== null && 'kind' in item && 'message' in item,
  );
}

export function useUpdateFlight(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: FlightUpdateInput) => updateFlight(id, input),
    onSuccess: (flight) => {
      queryClient.setQueryData(['flight', id], flight);
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-history', id] });
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

export function useFlightRequests(
  status?: string,
  // Выборка запрашивается только тем, у кого есть право: иначе рельс
  // со счётчиком отправлял бы запрос с каждого экрана и получал 403.
  enabled = true,
): UseQueryResult<Paged<FlightRequest>> {
  const query = new URLSearchParams({ perPage: '100' });
  if (status) query.set('status', status);

  return useQuery({
    queryKey: ['flight-requests', status ?? ''],
    queryFn: ({ signal }) =>
      request(`/flight-requests?${query.toString()}`, pagedSchema(flightRequestSchema), {
        signal,
      }),
    enabled,
  });
}

export function useApproveRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/flight-requests/${id}/approve`, flightSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
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
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-requests'] });
    },
  });
}

export const flightTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  clientId: z.string(),
  aircraftTypeId: z.string(),
  depIcao: z.string(),
  arrIcao: z.string(),
  depTimeLocal: z.string(),
  weekdays: z.array(z.number().int()),
  defaultServices: z
    .array(
      z.object({
        serviceId: z.string(),
        leg: z.enum(['departure', 'arrival']),
        attributes: z.record(z.unknown()),
      }),
    )
    .default([]),
});

export type FlightTemplateRow = z.infer<typeof flightTemplateSchema>;

export function useFlightTemplates(): UseQueryResult<Paged<FlightTemplateRow>> {
  return useQuery({
    queryKey: ['flight-templates'],
    queryFn: ({ signal }) =>
      request('/flight-templates?perPage=200', pagedSchema(flightTemplateSchema), { signal }),
  });
}

export interface CreateTemplateInput {
  name: string;
  clientId: string;
  aircraftTypeId: string;
  depIcao: string;
  arrIcao: string;
  /** Местное время аэропорта вылета: в UTC переводится при генерации серии. */
  depTimeLocal: string;
  weekdays: number[];
  defaultServices: { serviceId: string; leg: 'departure' | 'arrival'; attributes: object }[];
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTemplateInput) =>
      request('/flight-templates', flightTemplateSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-templates'] });
    },
  });
}

/** Генерация серии рейсов из шаблона `[ТЗ 3.1.1]`. */
export function useGenerateSeries() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; fromDate: string; toDate: string }) =>
      request(
        `/flight-templates/${input.id}/generate`,
        z.object({ data: z.array(flightRowSchema) }),
        {
          method: 'POST',
          body: { fromDate: input.fromDate, toDate: input.toDate },
          idempotencyKey: newIdempotencyKey(),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
    },
  });
}
