/**
 * Клиент REST API.
 *
 * Типы ответов НЕ пишутся руками: они генерируются из `openapi.yaml`
 * командой `make api-types` в `shared/api-types.ts` (`CLAUDE.md § 3` п. 6).
 * Здесь — только транспорт: заголовки, конверт ответа, разбор ошибок,
 * идемпотентность.
 *
 * Внешние данные валидируются через zod (`CLAUDE.md § 3` п. 15): ответ сервера
 * для клиента — внешние данные, даже если контракт согласован.
 */
import { z } from 'zod';

const BASE_URL = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '/api/v1';

/** Конверт ошибки (`openapi.yaml` ErrorResponse). */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const pageMetaSchema = z.object({
  total: z.number().int(),
  page: z.number().int(),
  perPage: z.number().int(),
});

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Ключ идемпотентности. Обязателен для запросов, помеченных в контракте
   * `x-idempotency: required` (ADR-018). Без него повтор операции при обрыве
   * связи создаст дубликат заявки — то есть двойной заказ у поставщика.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, idempotencyKey, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 204) {
    return schema.parse(undefined);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details ?? {},
      );
    }
    throw new ApiError(response.status, 'INTERNAL_ERROR', `HTTP ${String(response.status)}`, {});
  }

  return schema.parse(payload);
}

/** Ключ идемпотентности для одной пользовательской операции. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
