/** Журнал действий и пользователи `[ТЗ 3.6.3, 4.3]`. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { userSchema } from './auth';
import { pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';
import type { AuditEntry, IntegrationLogEntry, IntegrationStatus, User } from './types';

/**
 * Типы сущностей журнала — по `AuditEntityType` контракта. Один перечень
 * на проверку ответа и фильтр экрана: неизвестный тип в ответе роняет
 * весь журнал, и второй список, отставший от первого, это гарантирует.
 */
export const AUDIT_ENTITY_TYPES = [
  'flight', 'service_order', 'vendor', 'client', 'contract', 'tariff', 'quote',
  'invoice', 'payable', 'payment', 'reconciliation', 'user', 'settings', 'crew',
  'aircraft', 'service', 'airport', 'report_subscription', 'vendor_price',
  'outbox_message', 'inbox_message', 'message_template',
] as const;

export const auditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  actorRole: z.enum(['admin', 'dispatcher', 'sales', 'finance', 'manager', 'client', 'vendor']),
  source: z.enum(['user', 'seed', 'system']),
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: z.string(),
  action: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  comment: z.string().nullable(),
  clockShifted: z.boolean(),
}) satisfies z.ZodType<AuditEntry>;

export type AuditEntryRow = z.infer<typeof auditEntrySchema>;

/** Проверка формы: журнал в контракте и здесь — одно и то же. */
export type AuditEntryFromContract = AuditEntry;

export interface AuditFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
}

export function useAuditEntries(filters: AuditFilters): UseQueryResult<Paged<AuditEntryRow>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  query.set('page', String(filters.page ?? 1));
  query.set('perPage', String(filters.perPage ?? 50));

  return useQuery({
    queryKey: ['audit', query.toString()],
    queryFn: ({ signal }) =>
      request(`/audit?${query.toString()}`, pagedSchema(auditEntrySchema), { signal }),
    placeholderData: (previous) => previous,
  });
}

export function useUsers(role?: string): UseQueryResult<Paged<User>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (role) query.set('role', role);

  return useQuery({
    queryKey: ['users', role ?? ''],
    queryFn: ({ signal }) =>
      request(`/users?${query.toString()}`, pagedSchema(userSchema), { signal }),
  });
}

export interface CreateUserInput {
  name: string;
  email: string;
  role: string;
  clientId?: string;
  vendorId?: string;
  locale?: 'ru' | 'en';
  timezone?: string;
}

/**
 * Заведение пользователя `[ТЗ 4.3]`.
 *
 * Пароль здесь не задаётся: он приходит письмом либо учётная запись
 * связывается с каталогом. Форма, в которой администратор придумывает
 * пароль за человека, — способ получить один пароль на весь отдел.
 */
export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      request('/users', userSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

// ─────────────────────── Генератор данных ───────────────────────

const sampleDataResultSchema = z.object({
  action: z.enum(['generate', 'reset', 'purge']),
  counts: z.record(z.number().int()),
  // Записи набора, которые очистка оставила: на них ссылаются записи людей (ADR-041).
  kept: z.array(
    z.object({ entity: z.string(), id: z.string(), title: z.string(), reason: z.string() }),
  ),
  // Поле обязательное: сервер возвращает его всегда, в том числе пустым.
  message: z.string(),
});

export type SampleDataResult = z.infer<typeof sampleDataResultSchema>;

/**
 * Управление набором генератора `[ТЗ этап 2]` (ADR-008, ADR-016).
 *
 * Действие выполняет сервер той же командой, что и `make seed-sample`:
 * набор, собранный кнопкой, обязан совпадать с набором, собранным командой.
 * При выключенном генераторе сервер отказывает — это не проверка на клиенте.
 */
export function useSampleDataAction(action: 'generate' | 'reset' | 'purge') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (seed?: number) =>
      request(`/sample-data/${action}`, sampleDataResultSchema, {
        method: 'POST',
        body: action === 'purge' ? {} : { seed },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      // Набор изменился целиком: держать список того, что могло поменяться,
      // значит забыть в нём очередной экран.
      void queryClient.invalidateQueries();
    },
  });
}

// ─────────────────────── Внешние подключения (ADR-039) ───────────────────────

const integrationCodeSchema = z.enum([
  'FX', 'WX', 'TRACK', 'APT', 'SMTP', 'MSGR', 'MAILBOT', 'LDAP', 'ONEC', 'EDO', 'BI',
  'SLOT', 'VENDOR_API', 'IATA',
]);

export const integrationStatusSchema = z.object({
  code: integrationCodeSchema,
  name: z.object({ ru: z.string(), en: z.string() }),
  // `null` — обменов ещё не было: состояние неизвестно, а не «исправно».
  healthy: z.boolean().nullable(),
  lastCheckAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
}) satisfies z.ZodType<IntegrationStatus>;

export type IntegrationStatusRow = z.infer<typeof integrationStatusSchema>;

export const integrationLogEntrySchema = z.object({
  id: z.string(),
  code: integrationCodeSchema,
  direction: z.enum(['outbound', 'inbound']),
  operation: z.string(),
  endpoint: z.string(),
  ts: z.string(),
  durationMs: z.number().int(),
  success: z.boolean(),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  responseSizeBytes: z.number().int(),
  relatedEntityType: z.string().nullable(),
  relatedEntityId: z.string().nullable(),
}) satisfies z.ZodType<IntegrationLogEntry>;

export type IntegrationLogRow = z.infer<typeof integrationLogEntrySchema>;

const integrationCheckSchema = z.object({
  code: integrationCodeSchema,
  success: z.boolean(),
  durationMs: z.number().int(),
  message: z.string(),
});

/**
 * Работающие подключения `[ТЗ 4.2]`. Выключенных сервер не отдаёт:
 * система их не вызывает, и показывать их как подключения незачем.
 */
export function useIntegrations(): UseQueryResult<{ data: IntegrationStatusRow[] }> {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: ({ signal }) =>
      request('/integrations', z.object({ data: z.array(integrationStatusSchema) }), { signal }),
  });
}

export function useIntegrationLogs(page: number): UseQueryResult<Paged<IntegrationLogRow>> {
  return useQuery({
    queryKey: ['integrations', 'logs', page],
    queryFn: ({ signal }) =>
      request(
        `/integrations/logs?page=${String(page)}&perPage=20`,
        pagedSchema(integrationLogEntrySchema),
        { signal },
      ),
    placeholderData: (previous) => previous,
  });
}

/** Настоящее обращение к внешней системе; результат попадает в журнал. */
export function useCheckIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (code: string) =>
      request(`/integrations/${code}/test`, integrationCheckSchema, { method: 'POST' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

// ─────────────────────────── Правила SLA ───────────────────────────

export const slaRuleSchema = z.object({
  id: z.string(),
  scope: z.object({ category: z.string().nullable(), vendorId: z.string().nullable() }),
  confirmMinutes: z.number().int(),
  completionMinutes: z.number().int().nullable(),
  penalty: z.object({ kind: z.enum(['none', 'fixed', 'percent']), value: z.string().nullable() }),
});

export type SlaRuleRow = z.infer<typeof slaRuleSchema>;

export function useSlaRules(): UseQueryResult<{ data: SlaRuleRow[] }> {
  return useQuery({
    queryKey: ['sla-rules'],
    queryFn: ({ signal }) =>
      request('/sla-rules', z.object({ data: z.array(slaRuleSchema) }), { signal }),
  });
}

export interface CreateSlaRuleInput {
  scope: { category: string | null; vendorId: string | null };
  confirmMinutes: number;
  completionMinutes: number | null;
  penalty: { kind: 'none' | 'fixed' | 'percent'; value: string | null };
}

/** Новое правило вытесняет прежнее той же области — история сохраняется (G-39). */
export function useCreateSlaRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateSlaRuleInput) =>
      request('/sla-rules', slaRuleSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sla-rules'] });
    },
  });
}

// ─────────────────────────── Настройки ───────────────────────────

export const settingsSchema = z.object({
  lowMarginThresholdPercent: z.string(),
  defaultMarkupPercent: z.string(),
  documentNumberMasks: z.object({ quote: z.string(), invoice: z.string(), payable: z.string() }),
  fxPolicy: z.enum(['document_date', 'order_date']),
  slaWeights: z.record(z.string()),
  vendorSuggestWeights: z.record(z.string()),
  contractExpiryReminders: z.array(z.number().int()),
  deicingRule: z.object({ tempWithPrecipC: z.number().int(), tempAlwaysC: z.number().int() }),
  pdRetentionMonths: z.number().int(),
  clockOffsetSeconds: z.number().int(),
  clockScale: z.number().int(),
  sampleData: z.boolean(),
});

export type SettingsRow = z.infer<typeof settingsSchema>;

export function useSettings(enabled = true): UseQueryResult<SettingsRow> {
  return useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => request('/settings', settingsSchema, { signal }),
    enabled,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (changes: Partial<Omit<SettingsRow, 'sampleData'>>) =>
      request('/settings', settingsSchema, { method: 'PATCH', body: changes }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], updated);
      // Порог и наценка участвуют в марже; модельное время — в часах всех экранов.
      void queryClient.invalidateQueries({ queryKey: ['flight-margin'] });
      void queryClient.invalidateQueries({ queryKey: ['clock'] });
    },
  });
}

// ─────────────────────────── Производительность ───────────────────────────

export const performanceReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  metrics: z.array(
    z.object({
      name: z.string(),
      source: z.enum(['server', 'client']),
      p50Ms: z.number().int().nullable(),
      p95Ms: z.number().int().nullable(),
      p99Ms: z.number().int().nullable(),
      sampleCount: z.number().int(),
      thresholdMs: z.number().int(),
      withinThreshold: z.boolean().nullable(),
    }),
  ),
});

export type PerformanceReportRow = z.infer<typeof performanceReportSchema>;

export function usePerformance(range: { from: string; to: string }): UseQueryResult<PerformanceReportRow> {
  const query = new URLSearchParams(range).toString();
  return useQuery({
    queryKey: ['performance', query],
    queryFn: ({ signal }) => request(`/performance?${query}`, performanceReportSchema, { signal }),
  });
}
