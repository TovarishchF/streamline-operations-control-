import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

import { ACCOUNTS, API, tokensFor } from './session';

/**
 * Подготовка данных сквозного сценария через API `SPEC.md § 12`.
 *
 * В наборе генератора нет прайсов и договоров поставщиков, а портальная
 * учётная запись — одна. Поэтому сценарий заводит своих поставщиков тем же
 * путём, что и настоящие: регистрация с паролем → подтверждение адреса
 * по письму (Mailpit) → согласование администратором → договор и цены.
 * Обходных путей в базу нет.
 */

const MAILPIT = process.env['SOC_MAILPIT_URL'] ?? 'http://localhost:8025';
export const VENDOR_PASSWORD = 'Scenarii-Parol-2026!';

/** Клиент API от имени пользователя. */
export class Api {
  private readonly request: APIRequestContext;
  private readonly access: string;

  private constructor(request: APIRequestContext, access: string) {
    this.request = request;
    this.access = access;
  }

  static async as(request: APIRequestContext, username: string, password?: string): Promise<Api> {
    const tokens = await tokensFor(request, username, password);
    return new Api(request, tokens.access);
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.access}` },
    });
    if (!response.ok()) throw new Error(`GET ${path}: HTTP ${String(response.status())} ${await response.text()}`);
    return (await response.json()) as T;
  }

  async post<T>(path: string, data: unknown = {}): Promise<T> {
    const response = await this.request.post(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.access}`, 'Idempotency-Key': randomUUID() },
      data,
    });
    if (!response.ok()) throw new Error(`POST ${path}: HTTP ${String(response.status())} ${await response.text()}`);
    return (await response.json()) as T;
  }
}

/** Ссылка подтверждения из письма в Mailpit: письмо уходит через Celery, не сразу. */
async function confirmationLink(
  request: APIRequestContext,
  email: string,
): Promise<{ requestId: string; token: string }> {
  type Address = { Address: string };
  type Summary = { ID: string; To: Address[]; Cc: Address[]; Bcc: Address[] };
  for (let attempt = 0; attempt < 90; attempt += 1) {
    // Отправка ставит адресатов в скрытую копию: поиск по «to:» их не видит,
    // поэтому просматриваются последние письма по всем полям адресата.
    const found = await request.get(`${MAILPIT}/api/v1/messages?limit=100`);
    const body = (await found.json()) as { messages?: Summary[] };
    const id = body.messages?.find((message) =>
      [...message.To, ...message.Cc, ...message.Bcc].some((item) => item.Address === email),
    )?.ID;
    if (id) {
      const message = (await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
        Text: string;
      };
      const match = /register\/confirm\?id=([^&\s]+)&token=([^\s]+)/.exec(message.Text);
      if (match?.[1] && match[2]) return { requestId: match[1], token: match[2] };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`письмо подтверждения для ${email} не пришло в Mailpit за полторы минуты`);
}

export interface ScenarioVendor {
  name: string;
  username: string;
  vendorId: string;
}

/**
 * Поставщик сценария: регистрация, подтверждение адреса, согласование,
 * договор на квартал и цены на услуги в аэропорту.
 */
export async function onboardVendor(
  request: APIRequestContext,
  admin: Api,
  options: {
    run: string;
    key: string;
    name: string;
    category: string;
    airport: string;
    prices: { serviceId: string; amount: string }[];
    validFrom: string;
    validTo: string;
  },
): Promise<ScenarioVendor> {
  const username = `e2e-${options.key}-${options.run}`.toLowerCase();
  const email = `${username}@example.test`;

  const anonymous = await request.post(`${API}/auth/register`, {
    data: {
      kind: 'vendor',
      contactName: 'Сценарный Контакт Поставщика',
      email,
      password: VENDOR_PASSWORD,
      companyName: options.name,
      legalName: `ООО «${options.name}»`,
      country: 'RU',
      specializations: [options.category],
      coverageAirports: [options.airport],
      comment: 'Сквозной сценарий SPEC § 12',
    },
  });
  if (anonymous.status() !== 202) throw new Error(`регистрация ${email}: ${await anonymous.text()}`);

  const link = await confirmationLink(request, email);
  const confirmed = await request.post(`${API}/auth/register/confirm`, { data: link });
  if (!confirmed.ok()) throw new Error(`подтверждение ${email}: ${await confirmed.text()}`);

  const queue = await admin.get<{ data: { id: string; email: string }[] }>(
    '/registration-requests?perPage=100',
  );
  const pending = queue.data.find((item) => item.email === email);
  if (!pending) throw new Error(`заявки ${email} нет в очереди согласования`);
  await admin.post(`/registration-requests/${pending.id}/approve`);

  const vendorApi = await Api.as(request, username, VENDOR_PASSWORD);
  const me = await vendorApi.get<{ user: { vendorId: string | null } }>('/auth/me');
  const vendorId = me.user.vendorId;
  if (!vendorId) throw new Error(`у ${username} нет поставщика`);

  await admin.post('/contracts', {
    vendorId,
    number: `E2E-${options.run}-${options.key}`.toUpperCase(),
    validFrom: options.validFrom,
    validTo: options.validTo,
    currency: 'RUB',
    paymentTerms: { mode: 'postpayment', deferDays: 14 },
    attachmentIds: [],
  });
  for (const price of options.prices) {
    await admin.post('/catalog/prices', {
      vendorId,
      serviceId: price.serviceId,
      airportIcao: options.airport,
      price: { amount: price.amount, currency: 'RUB' },
      minCharge: null,
      validFrom: options.validFrom,
      validTo: options.validTo,
      surcharges: [],
    });
  }
  return { name: options.name, username, vendorId };
}

/** Исправный борт без рейсов в сутки вокруг вылета: новому рейсу не с чем конфликтовать. */
export async function freeAircraft(api: Api, stdIso: string): Promise<string> {
  const fleet = await api.get<{ data: { id: string; registration: string }[] }>(
    '/fleet?status=serviceable&perPage=200',
  );
  const std = new Date(stdIso).getTime();
  const from = new Date(std - 36 * 3_600_000).toISOString();
  const to = new Date(std + 36 * 3_600_000).toISOString();
  for (const aircraft of fleet.data) {
    const busy = await api.get<{ meta: { total: number } }>(
      `/flights?aircraftId=${aircraft.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&perPage=1`,
    );
    if (busy.meta.total === 0) return aircraft.registration;
  }
  throw new Error('в парке нет свободного исправного борта на дату сценария');
}

export { ACCOUNTS };
