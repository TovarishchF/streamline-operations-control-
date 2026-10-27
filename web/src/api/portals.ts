/**
 * Порталы клиента `[ТЗ 3.5.3]` и поставщика `[ТЗ 4.3]`.
 *
 * Отдельные эндпоинты `/portal/*`: закупочных цен и поставщиков в ответе
 * портала клиента нет по построению ответа сервера, а не по фильтрации
 * здесь (`SPEC.md § 8.4`).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { moneySchema, pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';
import { vendorRatingSchema, type VendorRatingRow } from './counterparties';
import { payableSchema, type PayableRow } from './billing';
import { flightRequestSchema, flightStatusSchema } from './flights';
import { serviceOrderStatusSchema } from './orders';

const localizedNameSchema = z.object({ ru: z.string(), en: z.string() });

export const clientPortalFlightSchema = z.object({
  id: z.string(),
  number: z.string(),
  depIcao: z.string(),
  arrIcao: z.string(),
  stdUtc: z.string(),
  staUtc: z.string(),
  status: flightStatusSchema,
  services: z.array(
    z.object({
      serviceName: localizedNameSchema,
      leg: z.enum(['departure', 'arrival']),
      status: serviceOrderStatusSchema,
    }),
  ),
});

export type ClientPortalFlightRow = z.infer<typeof clientPortalFlightSchema>;

export function useClientPortalFlights(): UseQueryResult<Paged<ClientPortalFlightRow>> {
  return useQuery({
    queryKey: ['portal-client-flights'],
    queryFn: ({ signal }) =>
      request('/portal/client/flights?perPage=200', pagedSchema(clientPortalFlightSchema), {
        signal,
      }),
  });
}

export const clientPortalDocumentSchema = z.object({
  id: z.string(),
  kind: z.enum(['quote', 'invoice']),
  number: z.string(),
  issuedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
  status: z.string(),
  total: moneySchema,
});

export type ClientPortalDocumentRow = z.infer<typeof clientPortalDocumentSchema>;

export function useClientPortalDocuments(): UseQueryResult<Paged<ClientPortalDocumentRow>> {
  return useQuery({
    queryKey: ['portal-client-documents'],
    queryFn: ({ signal }) =>
      request('/portal/client/documents?perPage=200', pagedSchema(clientPortalDocumentSchema), {
        signal,
      }),
  });
}

export interface FlightRequestInput {
  depIcao: string;
  arrIcao: string;
  requestedStdUtc: string;
  paxCount: number;
  templateId?: string | null;
  comment: string;
}

/** Заявка на рейс: рейсом она станет после подтверждения диспетчером. */
export function useSubmitFlightRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: FlightRequestInput) =>
      request('/portal/client/flight-requests', flightRequestSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-requests'] });
    },
  });
}

export const vendorPortalOrderSchema = z.object({
  id: z.string(),
  serviceName: localizedNameSchema,
  airportIcao: z.string(),
  flightNumber: z.string(),
  scheduledAt: z.string(),
  quantity: z.string(),
  attributes: z.record(z.unknown()),
  agreedPrice: moneySchema.nullable(),
  status: serviceOrderStatusSchema,
  slaConfirmDeadline: z.string().nullable(),
  dispatcherContact: z.object({ name: z.string(), email: z.string() }).nullable(),
});

export type VendorPortalOrderRow = z.infer<typeof vendorPortalOrderSchema>;

export function useVendorPortalOrders(
  needsResponse: boolean,
): UseQueryResult<Paged<VendorPortalOrderRow>> {
  return useQuery({
    queryKey: ['portal-vendor-orders', needsResponse],
    queryFn: ({ signal }) =>
      request(
        `/portal/vendor/orders?perPage=200${needsResponse ? '&needsResponse=true' : ''}`,
        pagedSchema(vendorPortalOrderSchema),
        { signal },
      ),
  });
}

export function useVendorPortalPayables(): UseQueryResult<Paged<PayableRow>> {
  return useQuery({
    queryKey: ['portal-vendor-payables'],
    queryFn: ({ signal }) =>
      request('/portal/vendor/payables?perPage=200', pagedSchema(payableSchema), { signal }),
  });
}

export function useVendorPerformance(): UseQueryResult<VendorRatingRow> {
  return useQuery({
    queryKey: ['portal-vendor-performance'],
    queryFn: ({ signal }) => request('/portal/vendor/performance', vendorRatingSchema, { signal }),
  });
}
