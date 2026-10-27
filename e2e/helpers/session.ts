import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Вход в сквозных испытаниях `[ТЗ 4.3]`.
 *
 * Настоящий вход через API: сессию в хранилище браузера подложить нельзя —
 * там лежит только refresh-токен, а выдаёт его сервер (ADR-034). Это
 * заодно и проверка, что вход работает: испытания не начнутся, если он сломан.
 *
 * Для ролей с обязательным вторым фактором код считается здесь по секрету,
 * который `seed_sample` выдал при привязке. Реализация TOTP своя — тридцать
 * строк по RFC 6238: сторонняя библиотека проверяла бы сервер сама с собой,
 * а независимая реализация проверяет совместимость с любым приложением-
 * аутентификатором.
 */

export const API = process.env['SOC_API_URL'] ?? 'http://localhost:8000/api/v1';
/** Общий пароль пользователей генератора данных (`seed_sample`). */
export const PASSWORD = 'soc-vhod-2026-parol';

/** Ссылки otpauth пользователей генератора, записанные `seed_sample`. */
const TWO_FACTOR_FILE = resolve(process.cwd(), '../artifacts/sample-2fa.json');

export const ACCOUNTS: Record<string, string> = {
  usr_admin: 'volkova',
  usr_disp1: 'karpov',
  usr_disp2: 'nesterov',
  usr_fin: 'gordeeva',
  usr_mgr: 'sokolov',
  usr_client: 'lebedeva',
  usr_vendor: 'zaharov',
};

interface TokenPair {
  access: string;
  refresh: string;
  expiresIn: number;
}

function secretFor(username: string): string | null {
  let links: Record<string, string>;
  try {
    links = JSON.parse(readFileSync(TWO_FACTOR_FILE, 'utf-8')) as Record<string, string>;
  } catch {
    return null;
  }
  const url = links[username];
  if (!url) return null;
  return new URL(url.replace('otpauth://', 'https://')).searchParams.get('secret');
}

/** Декодирование base32 (RFC 4648) — в этом виде передаётся секрет TOTP. */
function fromBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Код TOTP по RFC 6238: SHA-1, шаг 30 секунд, шесть цифр. */
export function totp(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', fromBase32(secret)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

async function obtainTokens(page: Page, username: string): Promise<TokenPair> {
  return tokensFor(page.request, username);
}

/** Пара токенов пользователя — для подготовки данных через API. */
export async function tokensFor(
  request: APIRequestContext,
  username: string,
  password: string = PASSWORD,
): Promise<TokenPair> {
  const response = await request.post(`${API}/auth/login`, {
    data: { username, password },
  });
  if (!response.ok()) {
    throw new Error(
      `вход ${username} отклонён: HTTP ${String(response.status())} ${await response.text()}. ` +
        'Поднято ли окружение и выполнен ли make seed-sample?',
    );
  }

  const body = (await response.json()) as {
    twoFactorRequired: boolean;
    twoFactorToken?: string | null;
    tokens?: TokenPair | null;
  };

  if (!body.twoFactorRequired && body.tokens) {
    return body.tokens;
  }

  const secret = secretFor(username);
  if (!secret || !body.twoFactorToken) {
    throw new Error(
      `для ${username} нужен второй фактор, а секрет не найден в ${TWO_FACTOR_FILE}. ` +
        'Выполните make seed-sample.',
    );
  }

  const confirmed = await request.post(`${API}/auth/2fa`, {
    data: { twoFactorToken: body.twoFactorToken, code: totp(secret) },
  });
  if (!confirmed.ok()) {
    throw new Error(`второй фактор ${username} не принят: ${await confirmed.text()}`);
  }
  return (await confirmed.json()) as TokenPair;
}

/**
 * Готовит страницу к входу под заданной ролью.
 *
 * Токен кладётся в хранилище до загрузки страницы: приложение при старте
 * обменивает его на пару токенов и забирает профиль.
 *
 * Кладётся ровно один раз за сеанс браузера. Сервер отзывает прежний
 * refresh при каждом обновлении (ADR-034), поэтому подкладывать исходный
 * токен при каждом переходе значило бы выкидывать пользователя из системы
 * на втором экране.
 */
export async function signInAs(page: Page, roleKey: string): Promise<void> {
  const username = ACCOUNTS[roleKey] ?? ACCOUNTS['usr_disp1'];
  if (!username) throw new Error(`неизвестная роль ${roleKey}`);
  await signInWith(page, username);
}

/** Вход под конкретной учётной записью — например, заведённой самим испытанием. */
export async function signInWith(page: Page, username: string, password = PASSWORD): Promise<void> {
  const tokens = await tokensFor(page.request, username, password);
  await page.addInitScript((value: string) => {
    if (window.sessionStorage.getItem('soc.e2e.signed-in')) return;
    window.localStorage.setItem('soc.session', value);
    window.sessionStorage.setItem('soc.e2e.signed-in', '1');
  }, JSON.stringify({ state: { refreshToken: tokens.refresh }, version: 0 }));
}

/**
 * Идентификатор существующего рейса.
 *
 * Экраны рейсов работают на настоящем API, и жёстко заданный `flt_001`
 * из набора для макетов теперь даёт 404. Берём первый рейс из расписания:
 * какой именно — неважно, важно что он есть.
 */
export async function anyFlightId(page: Page, status = 'in_work'): Promise<string> {
  const tokens = await obtainTokens(page, ACCOUNTS['usr_disp1'] ?? 'karpov');
  const response = await page.request.get(`${API}/flights?status=${status}&perPage=1`, {
    headers: { Authorization: `Bearer ${tokens.access}` },
  });
  const body = (await response.json()) as { data: { id: string }[] };
  const first = body.data[0];
  if (!first) {
    throw new Error('в расписании нет рейсов: выполните make seed-sample');
  }
  return first.id;
}

/**
 * День расписания (UTC, `YYYY-MM-DD`), на который приходится больше всего рейсов.
 *
 * Набор генерируется относительно даты прогона генератора, а не сегодняшней:
 * планшет «от текущего момента» на устаревшем наборе пуст, и снимать его
 * для сверки полос бессмысленно.
 */
export async function busiestFlightDay(page: Page): Promise<string> {
  const tokens = await obtainTokens(page, ACCOUNTS['usr_disp1'] ?? 'karpov');
  const response = await page.request.get(`${API}/flights?perPage=200`, {
    headers: { Authorization: `Bearer ${tokens.access}` },
  });
  const body = (await response.json()) as { data: { stdUtc: string }[] };
  const counts = new Map<string, number>();
  for (const flight of body.data) {
    const day = flight.stdUtc.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!busiest) {
    throw new Error('в расписании нет рейсов: выполните make seed-sample');
  }
  return busiest[0];
}

/**
 * Первый идентификатор из списочного эндпоинта.
 *
 * Набор пересоздаётся генератором, и записанный в испытании `ven_003`
 * перестаёт существовать после первой же пересборки набора. Снимок экрана,
 * сделанный по 404, ничего не показывает, а испытание при этом зелёное —
 * поэтому идентификатор берётся с сервера, а не из памяти.
 */
export async function anyId(page: Page, resource: string, roleKey = 'usr_disp1'): Promise<string> {
  const tokens = await obtainTokens(page, ACCOUNTS[roleKey] ?? 'karpov');
  const response = await page.request.get(`${API}/${resource}?perPage=1`, {
    headers: { Authorization: `Bearer ${tokens.access}` },
  });
  if (!response.ok()) {
    throw new Error(`${resource}: HTTP ${String(response.status())}`);
  }
  const body = (await response.json()) as { data: { id: string }[] };
  const first = body.data[0];
  if (!first) {
    throw new Error(`в справочнике ${resource} пусто: выполните make seed-sample`);
  }
  return first.id;
}
