/**
 * Уведомления, исходящие, входящие, шаблоны сообщений.
 *
 * `SPEC.md § 8.2`: сообщение хранится целиком — канал, получатели, тема,
 * отрендеренное тело, вложения, статус и число попыток. В режиме `stub`
 * внешний вызов не выполняется, и это видно: бейдж канала показывает режим,
 * а не притворяется отправкой (`CLAUDE.md § 4`).
 */
import type {
  InboxMessage,
  MessageTemplate,
  Notification,
  OutboxMessage,
} from '@/api/types';

import { CLIENTS, VENDOR_BY_ID } from './counterparties';
import { FLIGHTS } from './flights';
import { hoursFromNow, required } from './reference';

// ─────────────────────────── Уведомления ───────────────────────────

export const NOTIFICATIONS: Notification[] = [
  { id: 'ntf_001', kind: 'sla_breach', severity: 'critical', title: 'Нарушен срок подтверждения заявки', body: 'Поставщик «ТЗК Северо-Запад» не подтвердил заявку на заправку в ULLI за 120 минут.', link: '/flights/flt_005/services', readAt: null, createdAt: hoursFromNow(-1) },
  { id: 'ntf_002', kind: 'service_rejected', severity: 'warning', title: 'Поставщик отказался от заявки', body: '«Скай Кейтеринг» отклонил заявку: нет свободного экипажа на запрошенное время.', link: '/flights/flt_003/services', readAt: null, createdAt: hoursFromNow(-3) },
  { id: 'ntf_003', kind: 'low_margin', severity: 'warning', title: 'Маржа рейса ниже порога', body: 'Рейс SLG-1042: маржа −14,0 % при пороге 12 %. Рекомендуется подобрать другого поставщика.', link: '/flights/flt_007/finance', readAt: null, createdAt: hoursFromNow(-5) },
  { id: 'ntf_004', kind: 'contract_expiry', severity: 'warning', title: 'Контракт истекает через 12 дней', body: 'Договор Д-2025/102 с «ТЗК Северо-Запад» истекает. Продлите или выберите другого поставщика.', link: '/contracts', readAt: null, createdAt: hoursFromNow(-8) },
  { id: 'ntf_005', kind: 'flight_status', severity: 'info', title: 'Рейс переведён в AOG', body: 'Борт RA-10211 — отказ системы кондиционирования. Затронут рейс SLG-1021.', link: '/flights/flt_004', readAt: hoursFromNow(-9), createdAt: hoursFromNow(-11) },
  { id: 'ntf_006', kind: 'deadline', severity: 'info', title: 'Приближается лидтайм заказа', body: 'До вылета SLG-1084 менее 24 часов, кейтеринг не заказан.', link: '/flights/flt_012/services', readAt: hoursFromNow(-12), createdAt: hoursFromNow(-14) },
  { id: 'ntf_007', kind: 'payment_overdue', severity: 'critical', title: 'Просроченная дебиторская задолженность', body: 'Счёт SOC-I-2026-0112 просрочен на 6 дней. Клиент «Гранд Турс».', link: '/billing/invoices', readAt: null, createdAt: hoursFromNow(-20) },
  { id: 'ntf_008', kind: 'service_confirmed', severity: 'info', title: 'Заявка подтверждена', body: '«Хэндлинг Про» подтвердил наземное обслуживание в UUEE.', link: '/flights/flt_002/services', readAt: hoursFromNow(-22), createdAt: hoursFromNow(-24) },
];

// ─────────────────────────── Исходящие ───────────────────────────

const TEMPLATE_BODIES: Record<string, { subject: string; body: string }> = {
  vendor_order: {
    subject: 'Заявка на обслуживание — рейс {{flight.number}}',
    body: 'Добрый день!\n\nПросим подтвердить обслуживание по рейсу {{flight.number}}.\n\nАэропорт: {{order.airport}}\nУслуга: {{order.service}}\nДата и время: {{order.scheduledAt}}\nКоличество: {{order.quantity}}\n\nПросим подтвердить до {{order.slaDeadline}}.\n\nС уважением,\nДиспетчерская служба SLG',
  },
  flight_confirmed: {
    subject: 'Подтверждение рейса {{flight.number}}',
    body: 'Уважаемый {{client.contact}}!\n\nПодтверждаем рейс {{flight.number}} по маршруту {{flight.route}}.\nВылет: {{flight.stdUtc}}\nПрилёт: {{flight.staUtc}}\n\nС уважением,\nSLG',
  },
  invoice: {
    subject: 'Счёт {{invoice.number}} по рейсу {{flight.number}}',
    body: 'Уважаемый {{client.contact}}!\n\nНаправляем счёт {{invoice.number}} на сумму {{invoice.total}}.\nСрок оплаты: {{invoice.dueDate}}.\n\nС уважением,\nФинансовая служба SLG',
  },
  contract_expiry: {
    subject: 'Истечение срока договора {{contract.number}}',
    body: 'Уважаемые коллеги!\n\nДоговор {{contract.number}} истекает {{contract.validTo}}.\nПросим сообщить о намерении продлить сотрудничество.\n\nС уважением,\nSLG',
  },
};

export const OUTBOX: OutboxMessage[] = FLIGHTS.slice(0, 26).map((flight, index) => {
  const isVendorLetter = index % 3 !== 0;
  const templateCode = isVendorLetter ? 'vendor_order' : index % 6 === 0 ? 'invoice' : 'flight_confirmed';
  const template = required(TEMPLATE_BODIES[templateCode], `шаблон ${templateCode}`);
  const client = CLIENTS.find((c) => c.id === flight.clientId);
  const vendor = VENDOR_BY_ID.get(index % 2 === 0 ? 'ven_003' : 'ven_001');

  const status: OutboxMessage['status'] =
    index % 9 === 4 ? 'failed' : index % 9 === 5 ? 'queued' : index % 9 === 6 ? 'sent' : 'delivered';

  return {
    id: `out_${String(index + 1).padStart(3, '0')}`,
    channel: index % 7 === 3 ? 'messenger' : 'email',
    channelMode: 'stub',
    to: isVendorLetter
      ? [{ name: vendor?.name ?? '', address: vendor?.contacts?.[0]?.email ?? '', locale: 'ru' }]
      : [{ name: client?.contacts?.[0]?.name ?? '', address: client?.contacts?.[0]?.email ?? '', locale: client?.defaultLocale ?? 'ru' }],
    templateCode,
    subject: `[DEMO] ${template.subject.replace('{{flight.number}}', flight.number).replace('{{invoice.number}}', 'SOC-I-2026-0107').replace('{{contract.number}}', 'Д-2025/102')}`,
    body: template.body
      .replace(/\{\{flight\.number\}\}/g, flight.number)
      .replace('{{flight.route}}', `${flight.depIcao} → ${flight.arrIcao}`)
      .replace('{{flight.stdUtc}}', new Date(flight.stdUtc).toISOString().slice(11, 16) + 'Z')
      .replace('{{flight.staUtc}}', new Date(flight.staUtc).toISOString().slice(11, 16) + 'Z')
      .replace('{{order.airport}}', flight.depIcao)
      .replace('{{order.service}}', 'Базовое наземное обслуживание')
      .replace('{{order.scheduledAt}}', new Date(flight.stdUtc).toISOString().slice(0, 16).replace('T', ' ') + 'Z')
      .replace('{{order.quantity}}', '1')
      .replace('{{order.slaDeadline}}', '2 часа с момента получения')
      .replace('{{client.contact}}', client?.contacts?.[0]?.name ?? 'коллеги')
      .replace('{{invoice.total}}', '1 284 900,00 ₽')
      .replace('{{invoice.dueDate}}', '30 дней с даты выставления'),
    attachments: templateCode === 'invoice'
      ? [{ id: 'att_inv_1', fileName: 'SOC-I-2026-0107.pdf', mimeType: 'application/pdf', sizeBytes: 214_500, kind: 'invoice', storageKey: 'docs/inv/107.pdf', uploadedAt: hoursFromNow(-30), uploadedBy: 'system' }]
      : [],
    relatedTo: { entityType: 'flight', entityId: flight.id },
    status,
    attempts: status === 'failed' ? 3 : 1,
    lastError: status === 'failed' ? 'SMTP 421: временная недоступность сервера получателя' : null,
    sentAt: status === 'queued' ? null : hoursFromNow(-index - 1),
    emlUrl: status === 'queued' ? null : `/api/v1/outbox/out_${String(index + 1).padStart(3, '0')}/eml`,
  };
});

// ─────────────────────────── Входящие ───────────────────────────
// INTEGRATIONS § 3.3: нераспознанное письмо — штатный сценарий, а не ошибка.

export const INBOX: InboxMessage[] = [
  { id: 'inb_001', channel: 'email', from: 'ops@ven_003.example.com', subject: 'RE: Заявка на обслуживание — рейс SLG-1007', body: 'Подтверждаем обслуживание. Ответственный: Морозов И.', receivedAt: hoursFromNow(-2), recognized: true, serviceOrderId: 'so_002_01', suggestedAction: 'confirm', appliedAt: null },
  { id: 'inb_002', channel: 'email', from: 'ops@ven_001.example.com', subject: 'RE: Заявка на обслуживание — рейс SLG-1014', body: 'Принято, топливозаправщик подан к 06:20Z.', receivedAt: hoursFromNow(-4), recognized: true, serviceOrderId: 'so_003_02', suggestedAction: 'confirm', appliedAt: hoursFromNow(-3) },
  { id: 'inb_003', channel: 'email', from: 'accounting@ven_003.example.com', subject: 'Счёт ХП-2026/4471', body: 'Направляем счёт за обслуживание за период. Во вложении XLSX.', receivedAt: hoursFromNow(-6), recognized: true, serviceOrderId: null, suggestedAction: 'import_invoice', appliedAt: null },
  { id: 'inb_004', channel: 'email', from: 'noreply@unknown-sender.example.com', subject: 'Обновление тарифов с 1 числа', body: 'Уведомляем об изменении тарифов на наземное обслуживание...', receivedAt: hoursFromNow(-7), recognized: false, serviceOrderId: null, suggestedAction: null, appliedAt: null },
  { id: 'inb_005', channel: 'email', from: 'ops@ven_005.example.com', subject: 'Отказ по заявке', body: 'К сожалению, не сможем обеспечить питание на указанную дату — нет свободного экипажа.', receivedAt: hoursFromNow(-9), recognized: true, serviceOrderId: 'so_003_03', suggestedAction: 'reject', appliedAt: hoursFromNow(-8) },
  { id: 'inb_006', channel: 'email', from: 'dispatcher@partner.example.com', subject: 'Fwd: slot request UUEE', body: 'Пересылаю ответ координатора, слот подтверждён на 06:55Z.', receivedAt: hoursFromNow(-12), recognized: false, serviceOrderId: null, suggestedAction: null, appliedAt: null },
];

// ─────────────────────────── Шаблоны ───────────────────────────
// Обязательный набор из SPEC § 8.2.

const TEMPLATE_CODES: Array<[string, string, string]> = [
  ['flight_confirmed', 'Подтверждение рейса клиенту', 'Flight confirmation to client'],
  ['flight_schedule_changed', 'Изменение расписания', 'Schedule change'],
  ['flight_cancelled', 'Отмена рейса', 'Flight cancellation'],
  ['quote', 'Котировка', 'Quote'],
  ['invoice', 'Счёт', 'Invoice'],
  ['closing_documents', 'Закрывающие документы', 'Closing documents'],
  ['vendor_order', 'Заявка поставщику', 'Vendor service order'],
  ['vendor_order_changed', 'Изменение заявки', 'Order change'],
  ['vendor_order_cancelled', 'Отмена заявки', 'Order cancellation'],
  ['vendor_reminder', 'Напоминание о сроке исполнения', 'Execution deadline reminder'],
  ['contract_expiry', 'Уведомление об истечении контракта', 'Contract expiry notice'],
  ['reconciliation_claim', 'Претензия по расхождению в сверке', 'Reconciliation claim'],
];

export const MESSAGE_TEMPLATES: MessageTemplate[] = TEMPLATE_CODES.map(([code, ru, en], index) => ({
  id: `tmpl_${String(index + 1).padStart(3, '0')}`,
  code,
  channel: 'email',
  subject: {
    ru: TEMPLATE_BODIES[code]?.subject ?? `${ru} — рейс {{flight.number}}`,
    en: `${en} — flight {{flight.number}}`,
  },
  body: {
    ru: TEMPLATE_BODIES[code]?.body ?? `Уважаемые коллеги!\n\n${ru} по рейсу {{flight.number}}.\n\nС уважением,\nSLG`,
    en: `Dear colleagues,\n\n${en} for flight {{flight.number}}.\n\nBest regards,\nSLG`,
  },
  variables: ['flight.number', 'flight.route', 'client.name', 'order.service', 'invoice.number'],
}));
