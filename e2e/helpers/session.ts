import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Вход в сквозных испытаниях `[ТЗ 4.3]`.
 *
 * Настоящий вход через API: сессию в хранилище браузера подложить нельзя —
 * там лежит только refresh-токен, а выдаёт его сервер (ADR-034). Это
 * заодно и проверка, что вход работает: испытания не начнутся, если он сломан.
 *
 * Для ролей с обязательным вторым фактором код считается здесь по секрету,
 * который `seed_demo` выдал при привязке. Реализация TOTP своя — тридцать
 * строк по RFC 6238: сторонняя библиотека проверяла бы сервер сама с собой,
 * а независимая реализация проверяет совместимость с любым приложением-
 * аутентификатором.
 */

const API = process.env['SOC_API_URL'] ?? 'http://localhost:8000/api/v1';
const PASSWORD = 'demo-stand-2026-parol';

/** Ссылки otpauth демонстрационных пользователей, записанные `seed_demo`. */
const TWO_FACTOR_FILE = resolve(process.cwd(), '../artifacts/demo-2fa.json');

export const ACCOUNTS: Record<string, string> = {
  usr_admin: 'volkova.demo',
  usr_disp1: 'karpov.demo',
  usr_disp2: 'nesterov.demo',
  usr_fin: 'gordeeva.demo',
  usr_mgr: 'sokolov.demo',
  usr_client: 'klient.demo',
  usr_vendor: 'postavshchik.demo',
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
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username, password: PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(
      `вход ${username} отклонён: HTTP ${String(response.status())} ${await response.text()}. ` +
        'Поднято ли окружение и выполнен ли make seed-demo?',
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
        'Выполните make seed-demo.',
    );
  }

  const confirmed = await page.request.post(`${API}/auth/2fa`, {
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

  const tokens = await obtainTokens(page, username);
  await page.addInitScript((value: string) => {
    if (window.sessionStorage.getItem('soc.e2e.signed-in')) return;
    window.localStorage.setItem('soc.session', value);
    window.sessionStorage.setItem('soc.e2e.signed-in', '1');
  }, JSON.stringify({ state: { refreshToken: tokens.refresh }, version: 0 }));
}
