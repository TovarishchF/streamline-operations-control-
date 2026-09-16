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

/**
 * Токен доступа живёт только в памяти вкладки (ADR-034): в хранилище
 * попадает лишь refresh, и обновляется он ротацией с отзывом прежнего.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Обновление пары токенов. Подставляется модулем аутентификации, чтобы
 * транспорт не знал ни про хранилище сессии, ни про форму ответа `/auth/refresh`.
 */
type RefreshHandler = () => Promise<boolean>;

let refreshTokens: RefreshHandler | null = null;

export function setRefreshHandler(handler: RefreshHandler | null): void {
  refreshTokens = handler;
}

/**
 * Одновременные запросы, наткнувшиеся на истёкший токен, обновляют его
 * один раз на всех: иначе каждый из них отзовёт refresh следующего
 * и разлогинит пользователя посреди работы.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (!refreshTokens) return false;
  refreshInFlight ??= refreshTokens().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
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
  /**
   * Не пытаться обновить токен при 401. Нужно самим запросам аутентификации:
   * иначе неверный пароль запускал бы обновление сессии, которой нет.
   */
  skipRefresh?: boolean;
}

export async function request<T>(
  path: string,
  // Схема объявлена по **разобранному** типу: у `z.ZodType<T>` вход
  // и выход совпадают, и схема со значениями по умолчанию выводила бы
  // тип входа — с необязательными полями там, где сервер их всегда шлёт.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, idempotencyKey, signal, skipRefresh = false } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    return fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  };

  let response = await send();

  // Токен доступа живёт 15 минут. Истёк — обновляем и повторяем запрос
  // ровно один раз: второй отказ означает, что сессия кончилась.
  if (response.status === 401 && !skipRefresh && (await refreshOnce())) {
    response = await send();
  }

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

/**
 * Ключ идемпотентности для одной пользовательской операции.
 *
 * `crypto.randomUUID` существует только в защищённом контексте: по HTTPS
 * и на `localhost`. Веб-клиент, открытый по HTTP на адрес в локальной сети —
 * а именно так к нему обращаются на стенде и в испытаниях, — получил бы
 * `undefined` и падение **на каждой** кнопке создания.
 *
 * Запасной путь собирает UUID v4 из `crypto.getRandomValues`: он доступен
 * везде. Биты версии и варианта выставляются по RFC 4122 — ключ должен быть
 * уникальным, а не похожим на UUID.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
