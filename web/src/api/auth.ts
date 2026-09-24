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
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { request } from './client';
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
