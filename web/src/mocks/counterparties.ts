/**
 * Клиенты, поставщики, контракты, тарифы.
 *
 * `CLAUDE.md § 4`: наименования вымышлены. Совпадения с настоящими компаниями
 * случайны и не подразумеваются.
 *
 * Обязательные «интересные» случаи (`SPEC.md § 11`): истекающий контракт,
 * истёкший контракт, поставщик без достаточных данных для рейтинга,
 * клиенты в трёх валютах расчётов.
 */
import type { Client, TariffRule, Vendor, VendorContract, VendorPrice } from '@/api/types';

import { daysFromNow } from './reference';

// ─────────────────────────── Клиенты ───────────────────────────

export const CLIENTS: Client[] = [
  {
    id: 'cli_001', name: 'Северный Ветер Карго', legalName: 'ООО «Северный Ветер Карго»',
    country: 'RU', settlementCurrency: 'RUB',
    paymentTerms: { mode: 'deferred', deferDays: 30 },
    defaultLocale: 'ru', isActive: true, dataSource: 'synthetic', isDemo: true,
    creditLimit: { amount: '15000000.0000', currency: 'RUB' },
    contacts: [
      { name: 'Нечаев Роман', role: 'Руководитель полётов', email: 'r.nechaev@example.com', phone: '+7 495 000-11-22', locale: 'ru', isPrimary: true },
      { name: 'Белова Ирина', role: 'Бухгалтерия', email: 'i.belova@example.com', locale: 'ru', isPrimary: false },
    ],
  },
  {
    id: 'cli_002', name: 'Аврора Джет', legalName: 'АО «Аврора Джет»',
    country: 'RU', settlementCurrency: 'RUB',
    paymentTerms: { mode: 'postpayment', deferDays: 0 },
    defaultLocale: 'ru', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Дьяконов Артур', role: 'Операционный директор', email: 'a.dyakonov@example.com', locale: 'ru', isPrimary: true }],
  },
  {
    id: 'cli_003', name: 'Meridian Air Charter', legalName: 'Meridian Air Charter Ltd.',
    country: 'AE', settlementCurrency: 'USD',
    paymentTerms: { mode: 'prepayment', deferDays: 0, prepaymentPercent: '50.0000' },
    defaultLocale: 'en', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'James Holloway', role: 'Flight Operations', email: 'j.holloway@example.com', locale: 'en', isPrimary: true }],
  },
  {
    id: 'cli_004', name: 'Alpine Executive', legalName: 'Alpine Executive SA',
    country: 'CH', settlementCurrency: 'EUR',
    paymentTerms: { mode: 'deferred', deferDays: 14 },
    defaultLocale: 'en', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Clara Brunner', role: 'Charter Manager', email: 'c.brunner@example.com', locale: 'en', isPrimary: true }],
  },
  {
    id: 'cli_005', name: 'Каспий Лоджистикс', legalName: 'ТОО «Каспий Лоджистикс»',
    country: 'KZ', settlementCurrency: 'USD',
    paymentTerms: { mode: 'deferred', deferDays: 45 },
    defaultLocale: 'ru', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Сагиндыков Ерлан', role: 'Логистика', email: 'e.sagindykov@example.com', locale: 'ru', isPrimary: true }],
  },
  {
    id: 'cli_006', name: 'Трансполярная Авиация', legalName: 'ООО «Трансполярная Авиация»',
    country: 'RU', settlementCurrency: 'RUB',
    paymentTerms: { mode: 'deferred', deferDays: 21 },
    defaultLocale: 'ru', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Мирошник Ольга', role: 'Диспетчерская', email: 'o.miroshnik@example.com', locale: 'ru', isPrimary: true }],
  },
  {
    id: 'cli_007', name: 'Восток Медэйр', legalName: 'ООО «Восток Медэйр»',
    country: 'RU', settlementCurrency: 'RUB',
    paymentTerms: { mode: 'prepayment', deferDays: 0, prepaymentPercent: '100.0000' },
    defaultLocale: 'ru', isActive: true, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Тимофеев Глеб', role: 'Санитарная авиация', email: 'g.timofeev@example.com', locale: 'ru', isPrimary: true }],
  },
  {
    id: 'cli_008', name: 'Гранд Турс', legalName: 'ООО «Гранд Турс»',
    country: 'RU', settlementCurrency: 'RUB',
    paymentTerms: { mode: 'deferred', deferDays: 30 },
    defaultLocale: 'ru', isActive: false, dataSource: 'synthetic', isDemo: true,
    contacts: [{ name: 'Панова Светлана', role: 'Закупки', email: 's.panova@example.com', locale: 'ru', isPrimary: true }],
  },
];

export const CLIENT_BY_ID = new Map(CLIENTS.map((c) => [c.id, c]));

// ─────────────────────────── Поставщики ───────────────────────────

interface VendorSeed {
  id: string;
  name: string;
  legal: string;
  specializations: Vendor['specializations'];
  airports: string[];
  currency: Vendor['settlementCurrency'];
  deferDays: number;
  quality: number;
  exchange: Vendor['exchangeMethod'];
  /** Число выполненных заявок — от него зависит, считается ли рейтинг. */
  orders: number;
  onTime: number;
  sla: number;
  billing: number;
  active?: boolean;
}

const VENDOR_SEEDS: VendorSeed[] = [
  { id: 'ven_001', name: 'Аэротопливо Центр', legal: 'ООО «Аэротопливо Центр»', specializations: ['fuel'], airports: ['UUEE', 'UUDD', 'UUWW'], currency: 'RUB', deferDays: 30, quality: 4, exchange: 'email', orders: 142, onTime: 0.94, sla: 0.91, billing: 0.97 },
  { id: 'ven_002', name: 'ТЗК Северо-Запад', legal: 'АО «ТЗК Северо-Запад»', specializations: ['fuel'], airports: ['ULLI', 'UUEE'], currency: 'RUB', deferDays: 21, quality: 3, exchange: 'portal', orders: 88, onTime: 0.81, sla: 0.76, billing: 0.88 },
  { id: 'ven_003', name: 'Хэндлинг Про', legal: 'ООО «Хэндлинг Про»', specializations: ['handling', 'transport'], airports: ['UUEE', 'UUDD', 'UUWW', 'ULLI'], currency: 'RUB', deferDays: 30, quality: 5, exchange: 'portal', orders: 210, onTime: 0.97, sla: 0.95, billing: 0.99 },
  { id: 'ven_004', name: 'Гранд Сервис Авиа', legal: 'ООО «Гранд Сервис Авиа»', specializations: ['handling'], airports: ['URSS', 'UWWW'], currency: 'RUB', deferDays: 14, quality: 3, exchange: 'email', orders: 54, onTime: 0.72, sla: 0.68, billing: 0.81 },
  { id: 'ven_005', name: 'Скай Кейтеринг', legal: 'ООО «Скай Кейтеринг»', specializations: ['catering'], airports: ['UUEE', 'UUDD'], currency: 'RUB', deferDays: 30, quality: 4, exchange: 'email', orders: 96, onTime: 0.9, sla: 0.88, billing: 0.94 },
  { id: 'ven_006', name: 'Фьюжн Кухня', legal: 'ООО «Фьюжн Кухня»', specializations: ['catering'], airports: ['UUWW', 'ULLI'], currency: 'RUB', deferDays: 21, quality: 5, exchange: 'portal', orders: 61, onTime: 0.93, sla: 0.9, billing: 0.96 },
  { id: 'ven_007', name: 'Emirates Ground Solutions', legal: 'Emirates Ground Solutions LLC', specializations: ['handling', 'catering', 'transport'], airports: ['OMDB'], currency: 'USD', deferDays: 45, quality: 5, exchange: 'api', orders: 73, onTime: 0.96, sla: 0.94, billing: 0.98 },
  { id: 'ven_008', name: 'Bosphorus FBO', legal: 'Bosphorus FBO A.S.', specializations: ['handling', 'fuel'], airports: ['LTFM'], currency: 'EUR', deferDays: 30, quality: 4, exchange: 'email', orders: 44, onTime: 0.88, sla: 0.85, billing: 0.92 },
  { id: 'ven_009', name: 'Léman Aviation Services', legal: 'Léman Aviation Services SA', specializations: ['handling', 'catering'], airports: ['LSGG'], currency: 'EUR', deferDays: 30, quality: 5, exchange: 'portal', orders: 38, onTime: 0.95, sla: 0.97, billing: 0.99 },
  { id: 'ven_010', name: 'Пермит Бюро', legal: 'ООО «Пермит Бюро»', specializations: ['permits'], airports: [], currency: 'USD', deferDays: 7, quality: 4, exchange: 'email', orders: 118, onTime: 0.86, sla: 0.83, billing: 0.9 },
  { id: 'ven_011', name: 'Глобал Пермитс', legal: 'Global Permits Ltd.', specializations: ['permits'], airports: [], currency: 'USD', deferDays: 14, quality: 5, exchange: 'api', orders: 67, onTime: 0.98, sla: 0.96, billing: 0.97 },
  { id: 'ven_012', name: 'Антилёд Сервис', legal: 'ООО «Антилёд Сервис»', specializations: ['deicing'], airports: ['UUEE', 'UUDD', 'UUWW', 'ULLI', 'UNNT'], currency: 'RUB', deferDays: 30, quality: 4, exchange: 'portal', orders: 82, onTime: 0.91, sla: 0.89, billing: 0.95 },
  { id: 'ven_013', name: 'Транспорт Экипаж', legal: 'ИП Ковалёв А. С.', specializations: ['transport'], airports: ['UUEE', 'UUDD'], currency: 'RUB', deferDays: 7, quality: 3, exchange: 'email', orders: 129, onTime: 0.79, sla: 0.74, billing: 0.86 },
  { id: 'ven_014', name: 'Сибирь Граунд', legal: 'ООО «Сибирь Граунд»', specializations: ['handling', 'fuel'], airports: ['UNNT', 'UWWW'], currency: 'RUB', deferDays: 30, quality: 4, exchange: 'email', orders: 47, onTime: 0.87, sla: 0.84, billing: 0.91 },
  // Недостаточно данных для рейтинга: меньше 5 заявок (DOMAIN § 7.4)
  { id: 'ven_015', name: 'Восток Хэндлинг', legal: 'ООО «Восток Хэндлинг»', specializations: ['handling'], airports: ['UHWW'], currency: 'RUB', deferDays: 14, quality: 3, exchange: 'email', orders: 3, onTime: 1, sla: 1, billing: 1 },
  { id: 'ven_016', name: 'Астана Эйр Сервис', legal: 'ТОО «Астана Эйр Сервис»', specializations: ['handling', 'fuel', 'catering'], airports: ['UACC'], currency: 'USD', deferDays: 30, quality: 4, exchange: 'email', orders: 29, onTime: 0.89, sla: 0.86, billing: 0.93 },
  { id: 'ven_017', name: 'Дельта Топливо', legal: 'ООО «Дельта Топливо»', specializations: ['fuel'], airports: ['URSS', 'UUOB'], currency: 'RUB', deferDays: 21, quality: 2, exchange: 'email', orders: 35, onTime: 0.64, sla: 0.58, billing: 0.72, active: false },
  { id: 'ven_018', name: 'Beijing Wings Handling', legal: 'Beijing Wings Handling Co.', specializations: ['handling', 'catering'], airports: ['ZBAA'], currency: 'USD', deferDays: 45, quality: 4, exchange: 'portal', orders: 22, onTime: 0.92, sla: 0.9, billing: 0.95 },
];

const WEIGHTS = { onTimeConfirm: 0.3, slaCompliance: 0.3, billing: 0.2, quality: 0.2 };

export const VENDORS: Vendor[] = VENDOR_SEEDS.map((seed) => {
  const sufficient = seed.orders >= 5;
  const rating = sufficient
    ? (
        5 *
        (WEIGHTS.onTimeConfirm * seed.onTime +
          WEIGHTS.slaCompliance * seed.sla +
          WEIGHTS.billing * seed.billing +
          WEIGHTS.quality * (seed.quality / 5))
      ).toFixed(4)
    : null;

  return {
    id: seed.id,
    name: seed.name,
    legalName: seed.legal,
    specializations: seed.specializations,
    coverage: { airports: seed.airports, regions: [] },
    settlementCurrency: seed.currency,
    paymentTerms: { mode: 'deferred', deferDays: seed.deferDays },
    exchangeMethod: seed.exchange,
    manualQualityScore: seed.quality,
    isActive: seed.active ?? true,
    dataSource: 'synthetic',
    isDemo: true,
    certificates:
      seed.specializations.includes('fuel')
        ? [{ kind: 'IATA' as const, number: `IFQP-${seed.id.slice(-3)}`, validFrom: daysFromNow(-400), validTo: daysFromNow(180) }]
        : [],
    contacts: [
      { name: 'Диспетчерская', role: 'Приём заявок', email: `ops@${seed.id}.example.com`, phone: '+7 495 000-00-00', locale: seed.currency === 'RUB' ? ('ru' as const) : ('en' as const), isPrimary: true },
    ],
    rating: {
      sufficientData: sufficient,
      rating,
      orderCount: seed.orders,
      components: {
        onTimeConfirmRate: seed.onTime.toFixed(4),
        slaComplianceRate: seed.sla.toFixed(4),
        billingAccuracy: seed.billing.toFixed(4),
        qualityScore: (seed.quality / 5).toFixed(4),
      },
      weights: {
        onTimeConfirm: '0.3000', slaCompliance: '0.3000', billing: '0.2000', quality: '0.2000',
      },
    },
  };
});

export const VENDOR_BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

// ─────────────────────────── Контракты ───────────────────────────
// Светофор сроков: действует / истекает / истёк (SPEC § 6.3).

export const CONTRACTS: VendorContract[] = VENDORS.flatMap((vendor, index) => {
  // Разные сроки, чтобы светофор было видно на экране.
  const daysLeft = [420, 12, 200, 5, 150, 26, 300, -14, 240, 90, 380, 3, 170, 210, 60, 130, -45, 110][index] ?? 180;
  const status: VendorContract['status'] =
    daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'expiring' : 'active';

  return [
    {
      id: `ctr_${String(index + 1).padStart(3, '0')}`,
      vendorId: vendor.id,
      number: `Д-${2025 + (index % 2)}/${String(index + 101)}`,
      validFrom: daysFromNow(-365 + index),
      validTo: daysFromNow(daysLeft),
      currency: vendor.settlementCurrency,
      paymentTerms: vendor.paymentTerms,
      status,
      attachments: [],
    },
  ];
});

export const CONTRACT_BY_VENDOR = new Map(CONTRACTS.map((c) => [c.vendorId, c]));

// ─────────────────────────── Цены поставщиков ───────────────────────────

interface PriceSeed {
  vendorId: string;
  serviceId: string;
  icao: string;
  amount: string;
  currency: VendorPrice['price']['currency'];
  min?: string;
}

const PRICE_SEEDS: PriceSeed[] = [
  { vendorId: 'ven_001', serviceId: 'svc_fuel_jeta1', icao: 'UUEE', amount: '72.4000', currency: 'RUB' },
  { vendorId: 'ven_001', serviceId: 'svc_fuel_jeta1', icao: 'UUDD', amount: '71.8000', currency: 'RUB' },
  { vendorId: 'ven_001', serviceId: 'svc_fuel_jeta1', icao: 'UUWW', amount: '73.1000', currency: 'RUB' },
  { vendorId: 'ven_002', serviceId: 'svc_fuel_jeta1', icao: 'ULLI', amount: '70.9000', currency: 'RUB' },
  { vendorId: 'ven_002', serviceId: 'svc_fuel_jeta1', icao: 'UUEE', amount: '74.2000', currency: 'RUB' },
  { vendorId: 'ven_003', serviceId: 'svc_hnd_basic', icao: 'UUEE', amount: '48000.0000', currency: 'RUB', min: '48000.0000' },
  { vendorId: 'ven_003', serviceId: 'svc_hnd_basic', icao: 'UUDD', amount: '44500.0000', currency: 'RUB' },
  { vendorId: 'ven_003', serviceId: 'svc_hnd_vip', icao: 'UUWW', amount: '126000.0000', currency: 'RUB' },
  { vendorId: 'ven_003', serviceId: 'svc_hnd_tow', icao: 'UUEE', amount: '18000.0000', currency: 'RUB' },
  { vendorId: 'ven_003', serviceId: 'svc_hnd_clean', icao: 'UUEE', amount: '12500.0000', currency: 'RUB' },
  { vendorId: 'ven_004', serviceId: 'svc_hnd_basic', icao: 'URSS', amount: '52000.0000', currency: 'RUB' },
  { vendorId: 'ven_005', serviceId: 'svc_cat_meal', icao: 'UUEE', amount: '4200.0000', currency: 'RUB' },
  { vendorId: 'ven_005', serviceId: 'svc_cat_crew', icao: 'UUEE', amount: '1800.0000', currency: 'RUB' },
  { vendorId: 'ven_006', serviceId: 'svc_cat_meal', icao: 'UUWW', amount: '5100.0000', currency: 'RUB' },
  { vendorId: 'ven_007', serviceId: 'svc_hnd_basic', icao: 'OMDB', amount: '1450.0000', currency: 'USD' },
  { vendorId: 'ven_007', serviceId: 'svc_cat_meal', icao: 'OMDB', amount: '64.0000', currency: 'USD' },
  { vendorId: 'ven_008', serviceId: 'svc_hnd_basic', icao: 'LTFM', amount: '980.0000', currency: 'EUR' },
  { vendorId: 'ven_009', serviceId: 'svc_hnd_basic', icao: 'LSGG', amount: '1620.0000', currency: 'EUR' },
  { vendorId: 'ven_010', serviceId: 'svc_prm_over', icao: 'UUEE', amount: '380.0000', currency: 'USD' },
  { vendorId: 'ven_011', serviceId: 'svc_prm_over', icao: 'UUEE', amount: '420.0000', currency: 'USD' },
  { vendorId: 'ven_011', serviceId: 'svc_prm_land', icao: 'OMDB', amount: '640.0000', currency: 'USD' },
  { vendorId: 'ven_012', serviceId: 'svc_dei_type1', icao: 'UUEE', amount: '310.0000', currency: 'RUB', min: '95000.0000' },
  { vendorId: 'ven_012', serviceId: 'svc_dei_type4', icao: 'UUEE', amount: '520.0000', currency: 'RUB', min: '140000.0000' },
  { vendorId: 'ven_013', serviceId: 'svc_trn_crew', icao: 'UUEE', amount: '9500.0000', currency: 'RUB' },
  { vendorId: 'ven_013', serviceId: 'svc_trn_vip', icao: 'UUEE', amount: '26000.0000', currency: 'RUB' },
  { vendorId: 'ven_014', serviceId: 'svc_hnd_basic', icao: 'UNNT', amount: '41000.0000', currency: 'RUB' },
  { vendorId: 'ven_016', serviceId: 'svc_hnd_basic', icao: 'UACC', amount: '890.0000', currency: 'USD' },
  { vendorId: 'ven_018', serviceId: 'svc_hnd_basic', icao: 'ZBAA', amount: '1180.0000', currency: 'USD' },
];

export const VENDOR_PRICES: VendorPrice[] = PRICE_SEEDS.map((seed, index) => ({
  id: `vpr_${String(index + 1).padStart(3, '0')}`,
  vendorId: seed.vendorId,
  serviceId: seed.serviceId,
  airportIcao: seed.icao,
  price: { amount: seed.amount, currency: seed.currency },
  minCharge: seed.min ? { amount: seed.min, currency: seed.currency } : null,
  validFrom: daysFromNow(-180),
  validTo: daysFromNow(180),
  surcharges:
    seed.serviceId.startsWith('svc_hnd')
      ? [
          {
            code: 'night' as const, kind: 'percent' as const, value: '25.0000',
            appliesWhen: { fromLocalTime: '22:00', toLocalTime: '06:00' },
          },
        ]
      : [],
}));

// ─────────────────────────── Тарифы клиентов ───────────────────────────
// Все три способа ценообразования (DOMAIN § 7.2).

export const TARIFF_RULES: TariffRule[] = [
  { id: 'trf_001', clientId: 'cli_001', scope: {}, pricing: { mode: 'cost_plus', markupPercent: '18.0000' }, validFrom: daysFromNow(-200), validTo: daysFromNow(165) },
  { id: 'trf_002', clientId: 'cli_001', scope: { category: 'fuel' }, pricing: { mode: 'cost_plus', markupPercent: '9.0000' }, validFrom: daysFromNow(-200), validTo: daysFromNow(165) },
  { id: 'trf_003', clientId: 'cli_001', scope: { category: 'permits' }, pricing: { mode: 'pass_through' }, validFrom: daysFromNow(-200), validTo: daysFromNow(165) },
  { id: 'trf_004', clientId: 'cli_001', scope: { serviceId: 'svc_hnd_basic', airportIcao: 'UUEE' }, pricing: { mode: 'fixed', price: { amount: '62000.0000', currency: 'RUB' } }, validFrom: daysFromNow(-90), validTo: daysFromNow(275) },
  { id: 'trf_005', clientId: 'cli_001', scope: { category: 'handling' }, pricing: { mode: 'cost_plus', markupPercent: '22.0000' }, discount: { kind: 'percent', value: '5.0000' }, validFrom: daysFromNow(-60), validTo: daysFromNow(305) },
  { id: 'trf_006', clientId: 'cli_002', scope: {}, pricing: { mode: 'cost_plus', markupPercent: '15.0000' }, validFrom: daysFromNow(-150), validTo: daysFromNow(215) },
  { id: 'trf_007', clientId: 'cli_003', scope: {}, pricing: { mode: 'cost_plus', markupPercent: '12.0000' }, validFrom: daysFromNow(-120), validTo: daysFromNow(245) },
  { id: 'trf_008', clientId: 'cli_003', scope: { category: 'permits' }, pricing: { mode: 'pass_through' }, validFrom: daysFromNow(-120), validTo: daysFromNow(245) },
  { id: 'trf_009', clientId: 'cli_004', scope: {}, pricing: { mode: 'cost_plus', markupPercent: '20.0000' }, validFrom: daysFromNow(-100), validTo: daysFromNow(265) },
  { id: 'trf_010', clientId: 'cli_007', scope: {}, pricing: { mode: 'cost_plus', markupPercent: '8.0000' }, validFrom: daysFromNow(-80), validTo: daysFromNow(285) },
];
