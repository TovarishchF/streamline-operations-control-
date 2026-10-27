/** Курсы валют и расчёты с поставщиками `[ТЗ 3.4.1, 3.4.2]`. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { currencyCodeSchema, moneySchema, pagedSchema, type Paged } from './catalog';
import { download, newIdempotencyKey, request } from './client';

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

// ─────────────────────── Расчёты с поставщиками ───────────────────────

export const payableStatusSchema = z.enum([
  'pending', 'approved', 'scheduled', 'paid', 'disputed', 'cancelled',
]);

export type PayableStatus = z.infer<typeof payableStatusSchema>;

export const payableSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  vendorId: z.string(),
  vendorName: z.string(),
  serviceOrderIds: z.array(z.string()),
  amount: moneySchema,
  dueDate: z.string(),
  status: payableStatusSchema,
  // Просрочку считает сервер: иначе она зависела бы от часов рабочего
  // места, а в режиме генератора — ещё и от модельного времени (ADR-014).
  isOverdue: z.boolean(),
  vendorInvoiceId: z.string().nullable(),
});

export type PayableRow = z.infer<typeof payableSchema>;

export function usePayables(params: {
  vendorId?: string;
  status?: string;
  overdue?: boolean;
  /** Выборка запрашивается только тем, у кого есть право на раздел. */
  enabled?: boolean;
}): UseQueryResult<Paged<PayableRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (params.vendorId) query.set('vendorId', params.vendorId);
  if (params.status) query.set('status', params.status);
  if (params.overdue) query.set('overdue', 'true');

  return useQuery({
    queryKey: ['payables', query.toString()],
    queryFn: ({ signal }) =>
      request(`/payables?${query.toString()}`, pagedSchema(payableSchema), { signal }),
    enabled: params.enabled ?? true,
  });
}

/** Согласование заявки на оплату `[ТЗ 3.4.2]`. */
export function useApprovePayable() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/payables/${id}/approve`, payableSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
    },
  });
}

// ─────────────────────────── Сверка ───────────────────────────

export const discrepancySchema = z.object({
  kind: z.enum([
    'price_mismatch', 'quantity_mismatch', 'missing_on_our_side', 'missing_on_their_side',
  ]),
  lineIndex: z.number().int().nullable(),
  serviceOrderId: z.string().nullable(),
  ours: moneySchema.nullable(),
  theirs: moneySchema.nullable(),
  resolution: z
    .enum(['accept_theirs', 'keep_ours', 'claim', 'investigate'])
    .nullable(),
  comment: z.string().nullable(),
});

export type DiscrepancyRow = z.infer<typeof discrepancySchema>;

export const vendorInvoiceSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  number: z.string(),
  issuedAt: z.string(),
  currency: currencyCodeSchema,
  lines: z.array(
    z.object({
      airportIcao: z.string(),
      serviceDate: z.string(),
      serviceCode: z.string(),
      quantity: z.string(),
      unitPrice: moneySchema,
      amount: moneySchema,
    }),
  ),
  reconciliation: z.object({
    matched: z.array(z.object({ lineIndex: z.number().int(), serviceOrderId: z.string() })),
    discrepancies: z.array(discrepancySchema),
    totalOurs: moneySchema,
    totalTheirs: moneySchema,
    delta: moneySchema,
    resolvedAt: z.string().nullable(),
  }),
  // Коды поставщика, которым не нашлось соответствия (ADR-024).
  unmappedCodes: z.array(z.string()),
});

export type VendorInvoiceRow = z.infer<typeof vendorInvoiceSchema>;

/** Реестр выполненных сверок `[ТЗ 3.4.2]`. */
export function useVendorInvoices(
  vendorId?: string,
): UseQueryResult<Paged<VendorInvoiceRow>> {
  const query = new URLSearchParams({ perPage: '100' });
  if (vendorId) query.set('vendorId', vendorId);

  return useQuery({
    queryKey: ['reconciliation', 'list', vendorId ?? ''],
    queryFn: ({ signal }) =>
      request(`/reconciliation?${query.toString()}`, pagedSchema(vendorInvoiceSchema), {
        signal,
      }),
  });
}

/**
 * Импорт счёта поставщика для сверки `[ТЗ 3.4.2]`: файл CSV или XLSX
 * по шаблону системы.
 *
 * Файл разбирает сервер, и сопоставление делает он же по `DOMAIN § 7.7`:
 * ключ, порядок разбора и допуск на округление — часть предметной области,
 * а не оформления экрана.
 */
export function useImportVendorInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { vendorId: string; file: File }) => {
      const form = new FormData();
      form.append('vendorId', input.vendorId);
      form.append('file', input.file);
      return request('/reconciliation/import', vendorInvoiceSchema, {
        method: 'POST',
        body: form,
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
      void queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });
}

/**
 * Шаблон счёта поставщика `[ТЗ 3.4.2]`. Колонки задаёт сервер — те же,
 * что он читает при импорте.
 */
export async function downloadInvoiceTemplate(fileFormat: 'xlsx' | 'csv'): Promise<void> {
  const { blob, filename } = await download(`/reconciliation/template?fileFormat=${fileFormat}`);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? `invoice-template.${fileFormat}`;
  link.click();
  URL.revokeObjectURL(url);
}

export function useVendorInvoice(id: string | undefined): UseQueryResult<VendorInvoiceRow> {
  return useQuery({
    queryKey: ['reconciliation', id],
    queryFn: ({ signal }) =>
      request(`/reconciliation/${id ?? ''}`, vendorInvoiceSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useResolveDiscrepancy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      discrepancyIndex: number;
      resolution: 'accept_theirs' | 'keep_ours' | 'claim' | 'investigate';
      comment?: string;
    }) =>
      request(`/reconciliation/${input.id}/resolve`, vendorInvoiceSchema, {
        method: 'POST',
        body: {
          discrepancyIndex: input.discrepancyIndex,
          resolution: input.resolution,
          comment: input.comment ?? '',
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
    },
  });
}

// ──────────────────── Номенклатура поставщика (ADR-024) ────────────────────

export const vendorServiceMappingSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorCode: z.string(),
  vendorName: z.string().default(''),
  serviceId: z.string(),
});

export type VendorServiceMappingRow = z.infer<typeof vendorServiceMappingSchema>;

export function useVendorServiceMappings(
  vendorId?: string,
): UseQueryResult<Paged<VendorServiceMappingRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (vendorId) query.set('vendorId', vendorId);

  return useQuery({
    queryKey: ['vendor-service-mappings', vendorId ?? ''],
    queryFn: ({ signal }) =>
      request(
        `/vendor-service-mappings?${query.toString()}`,
        pagedSchema(vendorServiceMappingSchema),
        { signal },
      ),
  });
}

export function useCreateVendorServiceMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      vendorId: string;
      vendorCode: string;
      vendorName?: string;
      serviceId: string;
    }) =>
      request('/vendor-service-mappings', vendorServiceMappingSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vendor-service-mappings'] });
    },
  });
}

// ─────────────────────────── Маржа рейса ───────────────────────────

export const marginModeSchema = z.enum(['plan', 'fact', 'mixed']);

export type MarginMode = z.infer<typeof marginModeSchema>;

/**
 * `MarginResult` из контракта (`DOMAIN.md § 7.3`).
 *
 * Отрицательная маржа приходит как есть, при нулевой выручке процента
 * нет (`null`, а не ноль). Курс рейса — рядом: суммы приведены по нему.
 */
export const marginResultSchema = z.object({
  mode: marginModeSchema,
  currency: currencyCodeSchema,
  revenue: moneySchema,
  cost: moneySchema,
  margin: moneySchema,
  marginPercent: z.string().nullable(),
  planPortionPercent: z.string().nullable(),
  isBelowThreshold: z.boolean(),
  thresholdPercent: z.string(),
  fx: fxSnapshotSchema.partial().extend({ rates: z.record(z.string()) }),
  calculatedAt: z.string(),
});

export type MarginResultRow = z.infer<typeof marginResultSchema>;

export function useFlightMargin(
  flightId: string | undefined,
  mode: MarginMode = 'mixed',
  enabled = true,
): UseQueryResult<MarginResultRow> {
  return useQuery({
    queryKey: ['flight-margin', flightId, mode],
    queryFn: ({ signal }) =>
      request(`/flights/${flightId ?? ''}/margin?mode=${mode}`, marginResultSchema, { signal }),
    enabled: Boolean(flightId) && enabled,
  });
}

// ─────────────────────────── Платежи ───────────────────────────

export const paymentSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  amount: moneySchema,
  receivedAt: z.string(),
  allocations: z.array(z.object({ invoiceId: z.string(), amount: moneySchema })),
  source: z.enum(['manual', 'onec', 'edo']),
  externalId: z.string(),
  comment: z.string(),
  fxRate: z.string().nullable(),
  createdAt: z.string(),
});

export type PaymentRow = z.infer<typeof paymentSchema>;

export function usePayments(params: {
  invoiceId?: string;
  clientId?: string;
}): UseQueryResult<Paged<PaymentRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (params.invoiceId) query.set('invoiceId', params.invoiceId);
  if (params.clientId) query.set('clientId', params.clientId);

  return useQuery({
    queryKey: ['payments', query.toString()],
    queryFn: ({ signal }) =>
      request(`/payments?${query.toString()}`, pagedSchema(paymentSchema), { signal }),
  });
}

export interface RegisterPaymentInput {
  clientId: string;
  amount: z.infer<typeof moneySchema>;
  receivedAt: string;
  allocations: { invoiceId: string; amount: z.infer<typeof moneySchema> }[];
  externalId?: string;
  comment?: string;
}

/**
 * Регистрация поступления (ADR-019). Статус счёта после неё выводит
 * сервер из суммы платежей — клиент его не присваивает.
 */
export function useRegisterPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RegisterPaymentInput) =>
      request('/payments', paymentSchema, {
        method: 'POST',
        body: { ...input, source: 'manual' },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}
