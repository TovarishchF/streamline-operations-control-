/**
 * Котировки и счета `[ТЗ 3.4.1]`.
 *
 * Эндпоинта изменения документа нет намеренно: выставленный документ
 * неизменяем (`BACKEND.md § 3.4`). Правка — это аннулирование и выпуск
 * нового, и в интерфейсе это отдельные действия, а не «сохранить».
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

export const quoteStatusSchema = z.enum([
  'draft',
  'issued',
  'accepted',
  'declined',
  'expired',
  'voided',
]);

export const invoiceStatusSchema = z.enum([
  'draft',
  'issued',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'voided',
]);

const fxSnapshotSchema = z.object({
  date: z.string(),
  base: z.string(),
  rates: z.record(z.string()),
  policy: z.string(),
  staleSince: z.string().nullable().optional(),
});

export const documentLineSchema = z.object({
  serviceOrderId: z.string().nullable(),
  description: z.string(),
  airportIcao: z.string(),
  quantity: z.string(),
  unitPrice: moneySchema,
  amount: moneySchema,
  vatRateId: z.string().nullable(),
  vatAmount: moneySchema,
  tariffRuleId: z.string().nullable(),
});

export type DocumentLineRow = z.infer<typeof documentLineSchema>;

const totalsSchema = z.object({
  subtotal: moneySchema,
  discountTotal: moneySchema,
  feesTotal: moneySchema,
  vatTotal: moneySchema,
  grandTotal: moneySchema,
});

export const quoteSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  flightId: z.string(),
  clientId: z.string(),
  status: quoteStatusSchema,
  issuedAt: z.string().nullable(),
  validUntil: z.string().nullable(),
  currency: z.string(),
  fx: fxSnapshotSchema,
  lines: z.array(documentLineSchema).default([]),
  fees: z.array(z.record(z.unknown())).default([]),
  totals: totalsSchema,
  voidedByDocId: z.string().nullable(),
  isDemo: z.boolean(),
});

export type QuoteRow = z.infer<typeof quoteSchema>;

export const planFactSchema = z.object({
  serviceOrderId: z.string(),
  kind: z.enum(['quantity_changed', 'price_changed', 'tariff_changed', 'added', 'removed']),
  planValue: moneySchema.nullable(),
  factValue: moneySchema.nullable(),
  comment: z.string(),
});

export type PlanFactRow = z.infer<typeof planFactSchema>;

export const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  flightId: z.string(),
  clientId: z.string(),
  quoteId: z.string().nullable(),
  status: invoiceStatusSchema,
  issuedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  fx: fxSnapshotSchema,
  lines: z.array(documentLineSchema).default([]),
  fees: z.array(z.record(z.unknown())).default([]),
  totals: totalsSchema,
  paidAmount: moneySchema,
  planFactComparison: z.array(planFactSchema).default([]),
  voidedByDocId: z.string().nullable(),
  isDemo: z.boolean(),
});

export type InvoiceRow = z.infer<typeof invoiceSchema>;

function listQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams({ perPage: '200' });
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

// ─────────────────────────── Котировки ───────────────────────────

export function useQuotes(params: {
  clientId?: string;
  flightId?: string;
  status?: string;
}): UseQueryResult<Paged<QuoteRow>> {
  return useQuery({
    queryKey: ['quotes', params.clientId ?? '', params.flightId ?? '', params.status ?? ''],
    queryFn: ({ signal }) =>
      request(`/quotes?${listQuery(params)}`, pagedSchema(quoteSchema), { signal }),
  });
}

export function useQuote(id: string | undefined): UseQueryResult<QuoteRow> {
  return useQuery({
    queryKey: ['quote', id],
    queryFn: ({ signal }) => request(`/quotes/${id ?? ''}`, quoteSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreateQuote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { flightId: string; validUntil?: string }) =>
      request('/quotes', quoteSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['quotes'] });
    },
  });
}

/** Выставление, аннулирование и ответ клиента — одним хуком на действие. */
export function useQuoteAction(action: 'issue' | 'void' | 'accept' | 'decline') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      request(`/quotes/${input.id}/${action}`, quoteSchema, {
        method: 'POST',
        ...(input.reason !== undefined ? { body: { reason: input.reason } } : {}),
      }),
    onSuccess: (quote) => {
      void queryClient.invalidateQueries({ queryKey: ['quotes'] });
      void queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
    },
  });
}

// ─────────────────────────── Счета ───────────────────────────

export function useInvoices(params: {
  clientId?: string;
  flightId?: string;
  status?: string;
  overdue?: string;
}): UseQueryResult<Paged<InvoiceRow>> {
  return useQuery({
    queryKey: [
      'invoices',
      params.clientId ?? '',
      params.flightId ?? '',
      params.status ?? '',
      params.overdue ?? '',
    ],
    queryFn: ({ signal }) =>
      request(`/invoices?${listQuery(params)}`, pagedSchema(invoiceSchema), { signal }),
  });
}

export function useInvoice(id: string | undefined): UseQueryResult<InvoiceRow> {
  return useQuery({
    queryKey: ['invoice', id],
    queryFn: ({ signal }) => request(`/invoices/${id ?? ''}`, invoiceSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { flightId: string; quoteId?: string }) =>
      request('/invoices', invoiceSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function useInvoiceAction(action: 'issue' | 'void') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      request(`/invoices/${input.id}/${action}`, invoiceSchema, {
        method: 'POST',
        ...(input.reason !== undefined ? { body: { reason: input.reason } } : {}),
      }),
    onSuccess: (invoice) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
    },
  });
}

const exportTicketSchema = z.object({
  taskId: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  downloadUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

/**
 * Выгрузка счёта в PDF или XLSX `[ТЗ 3.4.1]`.
 *
 * Файл собирает сервер: сумма в выгрузке обязана совпадать с суммой в API
 * и на экране до копейки, а считать её второй раз в браузере значит завести
 * второй источник истины. Наружу приходит подписанная ссылка со сроком
 * жизни, её и открывает браузер.
 */
export function useExportInvoice() {
  return useMutation({
    mutationFn: (input: { id: string; format: 'pdf' | 'xlsx' }) =>
      request(`/invoices/${input.id}/export`, exportTicketSchema, {
        method: 'POST',
        body: { format: input.format },
        idempotencyKey: newIdempotencyKey(),
      }),
  });
}
