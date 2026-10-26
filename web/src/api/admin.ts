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
import type { AuditEntry, User } from './types';

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
