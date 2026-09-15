/**
 * Отчётность `[ТЗ 3.6.1, 3.6.3]`.
 *
 * Колонки приходят с сервера вместе со строками: набор колонок задаётся
 * определением отчёта, и собирать его второй раз в браузере значило бы
 * завести второй источник истины — таблица на экране и заголовок выгрузки
 * разошлись бы при первом же изменении отчёта.
 *
 * Строки описаны как словарь неизвестных значений: у семи отчётов семь
 * разных наборов полей, и тип, перечисляющий их все, был бы ложью.
 * Отображением управляет тип колонки, объявленный сервером.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { newIdempotencyKey, request } from './client';

export const reportCodes = [
  'flights_period',
  'services_rendered',
  'financial',
  'vendors',
  'receivables_payables',
  'sla_breaches',
  'flight_audit',
] as const;

export type ReportCode = (typeof reportCodes)[number];

export const exportFormats = ['pdf', 'xlsx', 'csv', 'xml'] as const;
export type ExportFormat = (typeof exportFormats)[number];

const localizedNameSchema = z.object({ ru: z.string(), en: z.string() });

const reportParameterSchema = z.object({
  key: z.string(),
  type: z.string(),
  required: z.boolean(),
});

export type ReportParameter = z.infer<typeof reportParameterSchema>;

export const reportDefinitionSchema = z.object({
  code: z.string(),
  name: localizedNameSchema,
  parameters: z.array(reportParameterSchema).default([]),
});

export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

/** Тип колонки задаёт и выравнивание, и формат ячейки. */
export const reportColumnTypeSchema = z.enum([
  'string',
  'number',
  'money',
  'date',
  'percent',
]);

export type ReportColumnType = z.infer<typeof reportColumnTypeSchema>;

export const reportColumnSchema = z.object({
  key: z.string(),
  title: localizedNameSchema,
  type: reportColumnTypeSchema,
});

export type ReportColumn = z.infer<typeof reportColumnSchema>;

export type ReportRow = Record<string, unknown>;

export const reportResultSchema = z.object({
  code: z.string(),
  generatedAt: z.string(),
  currency: z.string(),
  isDemo: z.boolean(),
  columns: z.array(reportColumnSchema).default([]),
  rows: z.array(z.record(z.unknown())).default([]),
  totals: z.record(z.unknown()).default({}),
});

export type ReportResult = z.infer<typeof reportResultSchema>;

const catalogSchema = z.object({ data: z.array(reportDefinitionSchema) });

export function useReportCatalog(): UseQueryResult<ReportDefinition[]> {
  return useQuery({
    queryKey: ['report-catalog'],
    queryFn: async ({ signal }) =>
      (await request('/reports', catalogSchema, { signal })).data,
  });
}

/** Параметры построения. Пустые значения в строку запроса не попадают. */
export type ReportParams = Record<string, string | undefined>;

function toQuery(params: ReportParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

/**
 * Построение отчёта.
 *
 * Запрос не уходит, пока отчёт не выбран и не нажата кнопка: отчёт по всем
 * рейсам за период — тяжёлая выборка, и делать её на каждое движение
 * в форме отбора незачем.
 */
export function useReport(
  code: string | undefined,
  params: ReportParams,
  enabled: boolean,
): UseQueryResult<ReportResult> {
  const query = toQuery(params);

  return useQuery({
    queryKey: ['report', code ?? '', query],
    queryFn: ({ signal }) =>
      request(`/reports/${code ?? ''}?${query}`, reportResultSchema, { signal }),
    enabled: Boolean(code) && enabled,
  });
}

const exportTicketSchema = z.object({
  taskId: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  downloadUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export type ExportTicket = z.infer<typeof exportTicketSchema>;

/**
 * Выгрузка отчёта `[ТЗ 3.6.3]`.
 *
 * Файл собирает сервер: числа в выгрузке обязаны совпадать с числами
 * на экране, а пересчёт в браузере завёл бы второй источник истины.
 * Наружу приходит подписанная ссылка со сроком жизни.
 */
export function useExportReport() {
  return useMutation({
    mutationFn: (input: { code: string; format: ExportFormat; params: ReportParams }) =>
      request(
        `/reports/${input.code}/export?${toQuery(input.params)}`,
        exportTicketSchema,
        {
          method: 'POST',
          body: { format: input.format },
          idempotencyKey: newIdempotencyKey(),
        },
      ),
  });
}

// ─────────────────────────── Подписки ───────────────────────────

export const reportScheduleSchema = z.enum(['daily', 'weekly', 'monthly']);
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

export const reportSubscriptionSchema = z.object({
  id: z.string(),
  code: z.string(),
  schedule: reportScheduleSchema,
  timeUtc: z.string(),
  format: z.enum(exportFormats),
  recipients: z.array(z.string()).default([]),
  parameters: z.record(z.unknown()).default({}),
});

export type ReportSubscription = z.infer<typeof reportSubscriptionSchema>;

export interface SubscriptionInput {
  code: string;
  schedule: ReportSchedule;
  timeUtc: string;
  format: ExportFormat;
  recipients: string[];
}

const subscriptionsSchema = z.object({ data: z.array(reportSubscriptionSchema) });

export function useReportSubscriptions(): UseQueryResult<ReportSubscription[]> {
  return useQuery({
    queryKey: ['report-subscriptions'],
    queryFn: async ({ signal }) =>
      (await request('/report-subscriptions', subscriptionsSchema, { signal })).data,
  });
}

export function useCreateSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SubscriptionInput) =>
      request('/report-subscriptions', reportSubscriptionSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-subscriptions'] });
    },
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string } & Partial<SubscriptionInput>) => {
      const { id, ...changes } = input;
      return request(`/report-subscriptions/${id}`, reportSubscriptionSchema, {
        method: 'PATCH',
        body: changes,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-subscriptions'] });
    },
  });
}

/**
 * Отписка. Сервер снимает признак активности, а не удаляет запись:
 * история отправок на неё ссылается.
 */
export function useDeleteSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/report-subscriptions/${id}`, z.undefined(), { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-subscriptions'] });
    },
  });
}
