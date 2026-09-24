/**
 * Аутентификация `[ТЗ 4.3]`.
 *
 * Вход двухшаговый: пароль, затем — если приложение-аутентификатор привязано —
 * код из него либо одноразовый резервный код. Роли, для которых второй фактор
 * обязателен, входят по паролю, но до привязки приложения интерфейс не даёт
 * им ничего, кроме экрана привязки: сервер сообщает это признаком
 * `twoFactorSetupRequired`.
 *
 * Хранение токенов — ADR-034: access только в памяти вкладки, refresh
 * в `localStorage` с ротацией и отзывом прежнего при каждом обновлении.
 */
import {
  useMutation, useQuery, useQueryClient, type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';
import type { MeResponse, Role } from './types';

export const tokenPairSchema = z.object({
  access: z.string(),
  refresh: z.string(),
  expiresIn: z.number().int(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = z.object({
  twoFactorRequired: z.boolean(),
  twoFactorToken: z.string().nullable().optional(),
  tokens: tokenPairSchema.nullable().optional(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

const roleSchema: z.ZodType<Role> = z.enum([
  'admin',
  'dispatcher',
  'sales',
  'finance',
  'manager',
  'client',
  'vendor',
]);

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  organizationId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  locale: z.enum(['ru', 'en']),
  timezoneMode: z.enum(['utc', 'airport_local', 'user_local']),
  timezone: z.string(),
  twoFactorEnabled: z.boolean(),
  isActive: z.boolean(),
});

export const meSchema = z.object({
  user: userSchema,
  permissions: z.record(z.boolean()),
  demoMode: z.boolean().optional(),
  twoFactorSetupRequired: z.boolean().optional(),
});

export type Me = z.infer<typeof meSchema>;

export const twoFactorSetupSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  backupCodes: z.array(z.string()),
});

export type TwoFactorSetup = z.infer<typeof twoFactorSetupSchema>;

/** Проверка формы: сервер и клиент используют один и тот же профиль. */
export type ProfileFromContract = MeResponse;

export const demoAccountSchema = z.object({
  username: z.string(),
  name: z.string(),
  role: z.string(),
});

export type DemoAccount = z.infer<typeof demoAccountSchema>;

export const demoAccountsSchema = z.object({ data: z.array(demoAccountSchema) });

/**
 * Учётные записи для экрана входа `[ТЗ 4.3]` (ADR-013).
 *
 * Экономит набор логина, когда стенд показывают нескольким людям подряд.
 * Паролей в ответе нет: список не заменяет вход, а лишь подставляет логин.
 * Вне `DEMO_ACCOUNTS=true` сервер отдаёт пустой список, и выбор не выводится.
 */
export function useDemoAccounts(): UseQueryResult<DemoAccount[]> {
  return useQuery({
    queryKey: ['auth-accounts'],
    queryFn: async ({ signal }) =>
      (await request('/auth/accounts', demoAccountsSchema, { signal })).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ─────────────────────────── Регистрация ───────────────────────────

export interface RegistrationInput {
  kind: 'client' | 'vendor';
  contactName: string;
  email: string;
  phone?: string;
  password: string;
  companyName: string;
  legalName?: string;
  country?: string;
  taxId?: string;
  website?: string;
  specializations?: string[];
  coverageAirports?: string[];
  comment?: string;
}

export const registrationAcceptedSchema = z.object({
  status: z.literal('email_sent'),
  kind: z.enum(['client', 'vendor']),
});

/**
 * Регистрация заказчика или поставщика `[ТЗ 4.3]` (ADR-037).
 *
 * Ответ одинаков независимо от того, свободен адрес или занят: перебирать
 * чужие адреса через форму регистрации нельзя. Поэтому экран после подачи
 * говорит «проверьте почту», а не «учётная запись создана».
 */
export function useRegister() {
  return useMutation({
    mutationFn: (input: RegistrationInput) =>
      request('/auth/register', registrationAcceptedSchema, {
        method: 'POST',
        body: input,
      }),
  });
}

export const registrationConfirmedSchema = z.object({
  status: z.enum(['email_pending', 'pending', 'approved', 'rejected']),
  kind: z.enum(['client', 'vendor']),
});

export function useConfirmRegistration() {
  return useMutation({
    mutationFn: (input: { requestId: string; token: string }) =>
      request('/auth/register/confirm', registrationConfirmedSchema, {
        method: 'POST',
        body: input,
      }),
  });
}

export const registrationRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['client', 'vendor']),
  status: z.enum(['email_pending', 'pending', 'approved', 'rejected']),
  contactName: z.string(),
  email: z.string(),
  phone: z.string().default(''),
  companyName: z.string(),
  legalName: z.string().default(''),
  country: z.string().default(''),
  taxId: z.string().default(''),
  website: z.string().default(''),
  specializations: z.array(z.string()).default([]),
  coverageAirports: z.array(z.string()).default([]),
  comment: z.string().default(''),
  emailConfirmedAt: z.string().nullable(),
  createdAt: z.string(),
  decisionReason: z.string().default(''),
});

export type RegistrationRequestRow = z.infer<typeof registrationRequestSchema>;

/** Очередь руководителя: только поставщики. */
export function useRegistrationRequests(): UseQueryResult<Paged<RegistrationRequestRow>> {
  return useQuery({
    queryKey: ['registration-requests'],
    queryFn: ({ signal }) =>
      request('/registration-requests?perPage=100', pagedSchema(registrationRequestSchema), {
        signal,
      }),
  });
}

export function useDecideRegistration(decision: 'approve' | 'reject') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      request(`/registration-requests/${input.id}/${decision}`, registrationRequestSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        ...(decision === 'reject' ? { body: { reason: input.reason ?? '' } } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['registration-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
    },
  });
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return request('/auth/login', loginResponseSchema, {
    method: 'POST',
    body: { username, password },
    skipRefresh: true,
  });
}

export function verifyTwoFactor(twoFactorToken: string, code: string): Promise<TokenPair> {
  return request('/auth/2fa', tokenPairSchema, {
    method: 'POST',
    body: { twoFactorToken, code },
    skipRefresh: true,
  });
}

export function refresh(refreshToken: string): Promise<TokenPair> {
  return request('/auth/refresh', tokenPairSchema, {
    method: 'POST',
    body: { refresh: refreshToken },
    skipRefresh: true,
  });
}

export function fetchMe(): Promise<Me> {
  return request('/auth/me', meSchema);
}

export function logoutRequest(refreshToken: string): Promise<void> {
  return request('/auth/logout', z.void(), {
    method: 'POST',
    body: { refresh: refreshToken },
  });
}

export function setupTwoFactor(): Promise<TwoFactorSetup> {
  return request('/auth/2fa/setup', twoFactorSetupSchema, { method: 'POST' });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/auth/password', z.void(), {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}
