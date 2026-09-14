/**
 * Заявки на услуги `[ТЗ 3.2.2, 3.2.3]`.
 *
 * Проверки `SPEC.md § 5.2` выполняет сервер: мастер заказа показывает их
 * до отправки для удобства, но решение принимает сервер. Провал блокирующей
 * проверки приходит как 422 с перечнем в `details.checks` — его и нужно
 * показывать рядом с заблокированной кнопкой, а не общий текст ошибки.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { attachmentRefSchema } from './attachments';
import { moneySchema, pagedSchema, serviceSchema, surchargeSchema, type Paged } from './catalog';
import { ApiError, newIdempotencyKey, request } from './client';

export const serviceOrderStatusSchema = z.enum([
  'draft',
  'ordered',
  'confirmed',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
]);

export type ServiceOrderStatus = z.infer<typeof serviceOrderStatusSchema>;

export const serviceOrderTransitionSchema = z.enum([
  'order',
  'confirm',
  'reject',
  'begin',
  'finish',
  'cancel',
]);

export type ServiceOrderTransition = z.infer<typeof serviceOrderTransitionSchema>;

export const serviceOrderSchema = z.object({
  id: z.string(),
  flightId: z.string(),
  serviceId: z.string(),
  service: serviceSchema.optional(),
  leg: z.enum(['departure', 'arrival']),
  airportIcao: z.string(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  contractId: z.string().nullable(),
  status: serviceOrderStatusSchema,
  availableTransitions: z.array(serviceOrderTransitionSchema).default([]),
  quantity: z.string(),
  actualQuantity: z.string().nullable(),
  attributes: z.record(z.unknown()).default({}),
  purchasePrice: moneySchema.nullable(),
  actualPurchaseUnitPrice: moneySchema.nullable(),
  purchaseSurcharges: z.array(surchargeSchema).default([]),
  purchaseCost: moneySchema.nullable(),
  salePrice: moneySchema.nullable(),
  tariffRuleId: z.string().nullable(),
  contractTermsSnapshot: z.record(z.unknown()).default({}),
  orderedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  actualStartAt: z.string().nullable(),
  actualEndAt: z.string().nullable(),
  slaConfirmDeadline: z.string().nullable(),
  slaBreached: z.boolean(),
  rejectionReason: z.string().nullable(),
  replacedOrderId: z.string().nullable(),
  documents: z.array(attachmentRefSchema).default([]),
  dataSource: z.string(),
  isDemo: z.boolean(),
});

export type ServiceOrderRow = z.infer<typeof serviceOrderSchema>;

/** Результат одной проверки `SPEC.md § 5.2`, как его отдаёт сервер. */
export interface ServiceCheck {
  code: string;
  passed: boolean;
  blocking: boolean;
  message: string;
}

/**
 * Проверки из отказа сервера.
 *
 * Сервер кладёт их в `details.checks`. Разбор здесь, а не в компоненте:
 * форма деталей задана контрактом, и знать о ней должен слой API.
 */
export function checksFromError(error: unknown): ServiceCheck[] {
  if (!(error instanceof ApiError)) return [];
  const raw = error.details['checks'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ServiceCheck =>
      typeof item === 'object' && item !== null && 'code' in item && 'message' in item,
  );
}

/** Требует ли отказ подтверждения причиной (неблокирующие проверки). */
export function requiresOverride(error: unknown): boolean {
  return error instanceof ApiError && error.details['requiresOverride'] === true;
}

export function useFlightOrders(flightId: string | undefined): UseQueryResult<ServiceOrderRow[]> {
  return useQuery({
    queryKey: ['flight-orders', flightId],
    queryFn: ({ signal }) =>
      request(
        `/flights/${flightId ?? ''}/services`,
        z.object({ data: z.array(serviceOrderSchema) }),
        { signal },
      ).then((response) => response.data),
    enabled: Boolean(flightId),
  });
}

export function useServiceOrders(params: {
  vendorId?: string;
  status?: string;
  needsResponse?: boolean;
}): UseQueryResult<Paged<ServiceOrderRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (params.vendorId) query.set('vendorId', params.vendorId);
  if (params.status) query.set('status', params.status);
  if (params.needsResponse) query.set('needsResponse', 'true');

  return useQuery({
    queryKey: ['service-orders', query.toString()],
    queryFn: ({ signal }) =>
      request(`/service-orders?${query.toString()}`, pagedSchema(serviceOrderSchema), { signal }),
  });
}

export interface CreateOrderInput {
  flightId: string;
  serviceId: string;
  leg: 'departure' | 'arrival';
  quantity: string;
  vendorId?: string;
  attributes?: Record<string, unknown>;
  overrideReason?: string;
}

export function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ flightId, ...body }: CreateOrderInput) =>
      request(`/flights/${flightId}/services`, serviceOrderSchema, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['flight-orders', order.flightId] });
      void queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      // Переходы рейса зависят от состава заявок (`DOMAIN.md § 5.1`)
      void queryClient.invalidateQueries({ queryKey: ['flight', order.flightId] });
    },
  });
}

export interface OrderTransitionInput {
  id: string;
  transition: ServiceOrderTransition;
  comment?: string;
  actualStartAt?: string;
  actualEndAt?: string;
  actualQuantity?: string;
}

export function useOrderTransition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: OrderTransitionInput) =>
      request(`/service-orders/${id}/status`, serviceOrderSchema, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['flight-orders', order.flightId] });
      void queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['flight', order.flightId] });
    },
  });
}

export function useReassignOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; vendorId: string; comment?: string }) =>
      request(`/service-orders/${input.id}/reassign`, serviceOrderSchema, {
        method: 'POST',
        body: { vendorId: input.vendorId, comment: input.comment ?? '' },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['flight-orders', order.flightId] });
      void queryClient.invalidateQueries({ queryKey: ['service-orders'] });
    },
  });
}
