/** Журнал действий и пользователи `[ТЗ 3.6.3, 4.3]`. */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { userSchema } from './auth';
import { pagedSchema, type Paged } from './catalog';
import { request } from './client';
import type { AuditEntry, User } from './types';

export const auditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  actorRole: z.enum(['admin', 'dispatcher', 'sales', 'finance', 'manager', 'client', 'vendor']),
  source: z.enum(['user', 'seed', 'system']),
  entityType: z.enum([
    'flight', 'service_order', 'vendor', 'client', 'contract', 'tariff', 'quote',
    'invoice', 'payable', 'payment', 'reconciliation', 'user', 'settings', 'crew',
    'aircraft', 'service', 'airport',
  ]),
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
