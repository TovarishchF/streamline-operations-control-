/**
 * Аудит, интеграции, SLA, производительность, отчёты.
 *
 * `CLAUDE.md § 4`:
 * — записи аудита от генератора помечены `source: 'seed'` и автором
 *   «System (демо-генератор)», они визуально отличаются и не выдаются
 *   за действия людей;
 * — `/admin/integrations` показывает **фактический** режим подключения.
 */
import type {
  AuditEntry,
  IntegrationLogEntry,
  IntegrationStatus,
  PerformanceReport,
  ReportDefinition,
  SlaRule,
  User,
} from '@/api/types';

import { hoursFromNow } from './reference';

// ─────────────────────────── Пользователи ───────────────────────────

export const USERS: User[] = [
  { id: 'usr_admin', name: 'Волкова Анна', email: 'a.volkova@slg.example.com', role: 'admin', locale: 'ru', timezoneMode: 'utc', timezone: 'Europe/Moscow', twoFactorEnabled: true, isActive: true },
  { id: 'usr_disp1', name: 'Карпов Илья', email: 'i.karpov@slg.example.com', role: 'dispatcher', locale: 'ru', timezoneMode: 'utc', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
  { id: 'usr_disp2', name: 'Лебедев Пётр', email: 'p.lebedev@slg.example.com', role: 'dispatcher', locale: 'ru', timezoneMode: 'airport_local', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
  { id: 'usr_sales', name: 'Орлова Марина', email: 'm.orlova@slg.example.com', role: 'sales', locale: 'ru', timezoneMode: 'user_local', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
  { id: 'usr_fin', name: 'Зайцева Ольга', email: 'o.zaytseva@slg.example.com', role: 'finance', locale: 'ru', timezoneMode: 'utc', timezone: 'Europe/Moscow', twoFactorEnabled: true, isActive: true },
  { id: 'usr_mgr', name: 'Соколов Виктор', email: 'v.sokolov@slg.example.com', role: 'manager', locale: 'ru', timezoneMode: 'user_local', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
  { id: 'usr_client', name: 'Нечаев Роман', email: 'r.nechaev@example.com', role: 'client', clientId: 'cli_001', locale: 'ru', timezoneMode: 'user_local', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
  { id: 'usr_vendor', name: 'Громов Сергей', email: 's.gromov@ven_003.example.com', role: 'vendor', vendorId: 'ven_003', locale: 'ru', timezoneMode: 'airport_local', timezone: 'Europe/Moscow', twoFactorEnabled: false, isActive: true },
];

// ─────────────────────────── Аудит ───────────────────────────

interface AuditSeed {
  action: string;
  entityType: AuditEntry['entityType'];
  entityId: string;
  actor: string;
  role: AuditEntry['actorRole'];
  source: AuditEntry['source'];
  hours: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  comment?: string;
}

const AUDIT_SEEDS: AuditSeed[] = [
  { action: 'status_changed', entityType: 'flight', entityId: 'flt_004', actor: 'Карпов Илья', role: 'dispatcher', source: 'user', hours: -1, before: { status: 'in_work' }, after: { status: 'aog' }, comment: 'Отказ системы кондиционирования, ожидание запчасти' },
  { action: 'vendor_assigned', entityType: 'service_order', entityId: 'so_003_03_r', actor: 'Карпов Илья', role: 'dispatcher', source: 'user', hours: -3, before: { vendorId: 'ven_005' }, after: { vendorId: 'ven_006' }, comment: 'Переназначение после отказа' },
  { action: 'sla_breached', entityType: 'service_order', entityId: 'so_005_02', actor: 'System', role: 'admin', source: 'system', hours: -4, after: { slaBreached: true } },
  { action: 'invoice_issued', entityType: 'invoice', entityId: 'inv_003', actor: 'Зайцева Ольга', role: 'finance', source: 'user', hours: -6, before: { status: 'draft' }, after: { status: 'issued', number: 'SOC-I-2026-0109' } },
  { action: 'tariff_changed', entityType: 'tariff', entityId: 'trf_005', actor: 'Зайцева Ольга', role: 'finance', source: 'user', hours: -10, before: { markupPercent: '20.0000' }, after: { markupPercent: '22.0000' } },
  { action: 'flight_updated', entityType: 'flight', entityId: 'flt_026', actor: 'Лебедев Пётр', role: 'dispatcher', source: 'user', hours: -12, before: { stdUtc: '06:40Z' }, after: { stdUtc: '07:10Z' }, comment: 'Конфликт расписания подтверждён: задержка предыдущего рейса' },
  { action: 'discrepancy_resolved', entityType: 'reconciliation', entityId: 'vinv_002', actor: 'Зайцева Ольга', role: 'finance', source: 'user', hours: -26, after: { resolution: 'accept_theirs' } },
  { action: 'login', entityType: 'user', entityId: 'usr_fin', actor: 'Зайцева Ольга', role: 'finance', source: 'user', hours: -27 },
  { action: 'permissions_changed', entityType: 'user', entityId: 'usr_disp2', actor: 'Волкова Анна', role: 'admin', source: 'user', hours: -30, before: { role: 'dispatcher' }, after: { role: 'dispatcher', twoFactorEnabled: true } },
  { action: 'seed_generated', entityType: 'settings', entityId: 'demo', actor: 'System (демо-генератор)', role: 'admin', source: 'seed', hours: -48, comment: 'Сгенерирован демонстрационный набор, seed 20260913' },
  { action: 'seed_generated', entityType: 'flight', entityId: 'flt_001', actor: 'System (демо-генератор)', role: 'admin', source: 'seed', hours: -48 },
  { action: 'seed_generated', entityType: 'vendor', entityId: 'ven_001', actor: 'System (демо-генератор)', role: 'admin', source: 'seed', hours: -48 },
];

export const AUDIT: AuditEntry[] = AUDIT_SEEDS.map((seed, index) => ({
  id: `aud_${String(index + 1).padStart(3, '0')}`,
  ts: hoursFromNow(seed.hours),
  actorId: seed.source === 'seed' ? 'system' : `usr_${index}`,
  actorName: seed.actor,
  actorRole: seed.role,
  source: seed.source,
  entityType: seed.entityType,
  entityId: seed.entityId,
  action: seed.action,
  before: seed.before ?? null,
  after: seed.after ?? null,
  comment: seed.comment ?? null,
  clockShifted: false,
}));

// ─────────────────────────── Интеграции ───────────────────────────
// Фактический режим, а не желаемый. Колонка «что нужно для live» — из
// INTEGRATIONS § 6 и письма заказчику.

export const INTEGRATIONS: IntegrationStatus[] = [
  { code: 'FX', name: { ru: 'Курсы валют, ЦБ РФ', en: 'FX rates, CBR' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-0.2), lastSuccessAt: hoursFromNow(-0.2), errorRate24h: '0.0100', requiredForLive: 'Решение об официальном источнике курсов. Источник открыт, ключ не нужен.' },
  { code: 'WX', name: { ru: 'Погода METAR/TAF', en: 'Weather METAR/TAF' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-0.3), lastSuccessAt: hoursFromNow(-0.3), errorRate24h: '0.0200', requiredForLive: 'Ничего: источник NOAA открыт.' },
  { code: 'APT', name: { ru: 'Справочник аэропортов', en: 'Airport directory' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-6), lastSuccessAt: hoursFromNow(-6), errorRate24h: '0.0000', requiredForLive: 'Ничего: открытый набор данных OurAirports.' },
  { code: 'TRACK', name: { ru: 'Данные о движении ВС', en: 'Aircraft tracking' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-0.1), lastSuccessAt: hoursFromNow(-0.1), errorRate24h: '0.0500', requiredForLive: 'Решение по бюджету. OpenSky не покрывает всю бизнес-авиацию.' },
  { code: 'SMTP', name: { ru: 'Исходящая почта', en: 'Outgoing mail' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-0.1), lastSuccessAt: hoursFromNow(-0.1), errorRate24h: '0.0000', requiredForLive: 'Сервер, порт, учётные данные, адрес отправителя, настройка SPF/DKIM/DMARC.' },
  { code: 'MAILBOT', name: { ru: 'Разбор входящей почты', en: 'Inbound mail parsing' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-0.4), lastSuccessAt: hoursFromNow(-0.4), errorRate24h: '0.0200', requiredForLive: 'Выделенный ящик, доступ по IMAP, согласие на автоматическую обработку.' },
  { code: 'MSGR', name: { ru: 'Мессенджер MAX', en: 'MAX messenger' }, mode: 'stub', healthy: false, lastCheckAt: hoursFromNow(-0.1), lastSuccessAt: null, errorRate24h: '1.0000', requiredForLive: 'Наличие Bot API не подтверждено. Нужна документация, токен, идентификаторы чатов либо решение об альтернативе.' },
  { code: 'LDAP', name: { ru: 'Active Directory', en: 'Active Directory' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-1), lastSuccessAt: hoursFromNow(-1), errorRate24h: '0.0000', requiredForLive: 'Адрес контроллера домена, base DN, сервисная учётная запись, карта групп.' },
  { code: 'ONEC', name: { ru: '1С:Бухгалтерия', en: '1C Accounting' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-2), lastSuccessAt: hoursFromNow(-2), errorRate24h: '0.0300', requiredForLive: 'Версия и конфигурация, адрес публикации OData, учётная запись, перечень сопоставляемых реквизитов.' },
  { code: 'EDO', name: { ru: 'Электронный документооборот', en: 'E-document exchange' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-3), lastSuccessAt: hoursFromNow(-3), errorRate24h: '0.0000', requiredForLive: 'Договор с оператором, сертификат электронной подписи, доступ к API.' },
  { code: 'BI', name: { ru: 'Power BI / Tableau', en: 'Power BI / Tableau' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-4), lastSuccessAt: hoursFromNow(-4), errorRate24h: '0.0000', requiredForLive: 'Реплика только для чтения, перечень требуемых показателей, список подключающихся.' },
  { code: 'SLOT', name: { ru: 'Слот-координация', en: 'Slot coordination' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-5), lastSuccessAt: hoursFromNow(-5), errorRate24h: '0.0000', requiredForLive: 'Публичного подключения не существует. Реестр ведётся вручную, сообщения SSIM/SCR формируются системой.' },
  { code: 'VENDOR_API', name: { ru: 'Системы поставщиков', en: 'Vendor systems' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-5), lastSuccessAt: hoursFromNow(-5), errorRate24h: '0.0000', requiredForLive: 'Отраслевого стандарта не существует. Основные каналы — портал поставщика и почтовый робот.' },
  { code: 'IATA', name: { ru: 'IATA SIS / IS-XML', en: 'IATA SIS / IS-XML' }, mode: 'stub', healthy: true, lastCheckAt: hoursFromNow(-6), lastSuccessAt: hoursFromNow(-6), errorRate24h: '0.0000', requiredForLive: 'Уточнение по «BDG», решение о членстве и сертификации. Реализуется выгрузка IS-XML.' },
];

export const INTEGRATION_LOG: IntegrationLogEntry[] = Array.from({ length: 24 }, (_, i) => {
  const codes: IntegrationStatus['code'][] = ['FX', 'WX', 'TRACK', 'SMTP', 'MAILBOT', 'ONEC'];
  const code = codes[i % codes.length] ?? 'FX';
  const failed = i % 11 === 3;
  return {
    id: `ilog_${String(i + 1).padStart(3, '0')}`,
    code,
    mode: 'stub',
    direction: code === 'MAILBOT' ? 'inbound' : 'outbound',
    endpoint: code === 'FX' ? '/scripts/XML_daily.asp' : code === 'WX' ? '/api/data/metar' : '/odata/standard.odata',
    ts: hoursFromNow(-i * 0.7),
    durationMs: failed ? 5000 : 80 + ((i * 37) % 320),
    status: failed ? 503 : 200,
    responseSizeBytes: failed ? 0 : 1200 + i * 80,
    relatedEntityType: i % 4 === 0 ? 'flight' : null,
    relatedEntityId: i % 4 === 0 ? 'flt_002' : null,
  };
});

// ─────────────────────────── Правила SLA ───────────────────────────
// G-39: значения по умолчанию заданы нами, реальные сроки — от заказчика.

export const SLA_RULES: SlaRule[] = [
  { id: 'sla_001', scope: { category: 'fuel', vendorId: null }, confirmMinutes: 120, completionMinutes: 60, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_002', scope: { category: 'handling', vendorId: null }, confirmMinutes: 240, completionMinutes: 60, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_003', scope: { category: 'catering', vendorId: null }, confirmMinutes: 240, completionMinutes: 120, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_004', scope: { category: 'transport', vendorId: null }, confirmMinutes: 240, completionMinutes: 30, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_005', scope: { category: 'permits', vendorId: null }, confirmMinutes: 1440, completionMinutes: 2880, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_006', scope: { category: 'deicing', vendorId: null }, confirmMinutes: 60, completionMinutes: 45, penalty: { kind: 'none', value: '0.0000' } },
  { id: 'sla_007', scope: { category: null, vendorId: 'ven_004' }, confirmMinutes: 180, completionMinutes: 90, penalty: { kind: 'percent', value: '5.0000' } },
];

// ─────────────────────────── Производительность ───────────────────────────
// ADR-017: серверная и клиентская метрики, а не декларация.

export const PERFORMANCE: PerformanceReport = {
  from: hoursFromNow(-168),
  to: hoursFromNow(0),
  metrics: [
    { name: 'flight_card', source: 'server', p50Ms: 180, p95Ms: 420, p99Ms: 810, sampleCount: 4820, thresholdMs: 2000, withinThreshold: true },
    { name: 'flight_card', source: 'client', p50Ms: 640, p95Ms: 1380, p99Ms: 2110, sampleCount: 4820, thresholdMs: 2000, withinThreshold: true },
    { name: 'margin_calc', source: 'server', p50Ms: 240, p95Ms: 690, p99Ms: 1240, sampleCount: 2110, thresholdMs: 5000, withinThreshold: true },
    { name: 'schedule', source: 'server', p50Ms: 310, p95Ms: 940, p99Ms: 1680, sampleCount: 6240, thresholdMs: 3000, withinThreshold: true },
    { name: 'schedule', source: 'client', p50Ms: 880, p95Ms: 2240, p99Ms: 3410, sampleCount: 6240, thresholdMs: 3000, withinThreshold: true },
    { name: 'reconciliation_import', source: 'server', p50Ms: 1420, p95Ms: 4900, p99Ms: 8200, sampleCount: 62, thresholdMs: 10000, withinThreshold: true },
  ],
};

// ─────────────────────────── Каталог отчётов ───────────────────────────

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  { code: 'flights_period', name: { ru: 'Рейсы за период', en: 'Flights for period' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }, { key: 'clientId', type: 'string', required: false }] },
  { code: 'services_rendered', name: { ru: 'Оказанные услуги', en: 'Services rendered' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }, { key: 'category', type: 'string', required: false }] },
  { code: 'financial', name: { ru: 'Финансовый: доходы, расходы, маржа', en: 'Financial: revenue, cost, margin' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }, { key: 'currency', type: 'string', required: false }] },
  { code: 'vendors', name: { ru: 'Поставщики: объём, качество, нарушения', en: 'Vendors: volume, quality, breaches' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }] },
  { code: 'receivables_payables', name: { ru: 'Дебиторская и кредиторская задолженность', en: 'Receivables and payables' }, parameters: [{ key: 'asOf', type: 'date', required: true }] },
  { code: 'sla_breaches', name: { ru: 'Реестр нарушений SLA', en: 'SLA breach register' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }] },
  { code: 'flight_audit', name: { ru: 'Журнал изменений рейсов', en: 'Flight change log' }, parameters: [{ key: 'from', type: 'date', required: true }, { key: 'to', type: 'date', required: true }] },
];
