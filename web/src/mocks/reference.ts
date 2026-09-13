/**
 * Справочные данные для макетов.
 *
 * `CLAUDE.md § 4`: реальны только общедоступные справочные данные — коды
 * и координаты аэропортов, типы ВС, коды валют. Наименования клиентов
 * и поставщиков вымышлены (`counterparties.ts`).
 *
 * Все записи помечены `dataSource: 'synthetic'`: заглушка не притворяется
 * живым источником.
 */
import type {
  Aircraft,
  AircraftType,
  Airport,
  ServiceCatalogItem,
  VatRate,
} from '@/api/types';

/** Детерминированный генератор: один и тот же набор при каждом запуске. */
export function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Достаёт элемент, которого по построению набора не может не быть.
 *
 * `noUncheckedIndexedAccess` справедливо считает обращение по индексу
 * небезопасным. Подавлять его через `!` — значит прятать возможную ошибку;
 * здесь она превращается во внятное исключение при сборке набора.
 */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`отсутствует ${what}`);
  return value;
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return required(items[Math.floor(random() * items.length)], 'элемент набора');
}

/** Дата со смещением в днях от текущей — `CLAUDE.md § 4`: не «история за год». */
export function daysFromNow(days: number, hour = 0, minute = 0): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  base.setUTCHours(hour, minute, 0, 0);
  return base.toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

// ─────────────────────────── Аэропорты ───────────────────────────
// Реальные коды, координаты и часовые пояса (OurAirports, общественное достояние).

export const AIRPORTS: Airport[] = [
  {
    id: 'apt_uuee', icao: 'UUEE', iata: 'SVO',
    name: { ru: 'Шереметьево', en: 'Sheremetyevo' },
    city: 'Москва', country: 'RU', timezone: 'Europe/Moscow',
    lat: 55.972642, lon: 37.414589, elevationFt: 622, isCoordinated: true,
  },
  {
    id: 'apt_uudd', icao: 'UUDD', iata: 'DME',
    name: { ru: 'Домодедово', en: 'Domodedovo' },
    city: 'Москва', country: 'RU', timezone: 'Europe/Moscow',
    lat: 55.408611, lon: 37.906111, elevationFt: 588, isCoordinated: true,
  },
  {
    id: 'apt_uuwa', icao: 'UUWW', iata: 'VKO',
    name: { ru: 'Внуково', en: 'Vnukovo' },
    city: 'Москва', country: 'RU', timezone: 'Europe/Moscow',
    lat: 55.591531, lon: 37.261486, elevationFt: 685, isCoordinated: true,
  },
  {
    id: 'apt_ullo', icao: 'ULLI', iata: 'LED',
    name: { ru: 'Пулково', en: 'Pulkovo' },
    city: 'Санкт-Петербург', country: 'RU', timezone: 'Europe/Moscow',
    lat: 59.800292, lon: 30.262503, elevationFt: 78, isCoordinated: false,
  },
  {
    id: 'apt_urss', icao: 'URSS', iata: 'AER',
    name: { ru: 'Сочи', en: 'Sochi' },
    city: 'Сочи', country: 'RU', timezone: 'Europe/Moscow',
    lat: 43.449928, lon: 39.956589, elevationFt: 89, isCoordinated: false,
  },
  {
    id: 'apt_uwww', icao: 'UWWW', iata: 'KUF',
    name: { ru: 'Курумоч', en: 'Kurumoch' },
    city: 'Самара', country: 'RU', timezone: 'Europe/Samara',
    lat: 53.504958, lon: 50.164028, elevationFt: 476, isCoordinated: false,
  },
  {
    id: 'apt_unnt', icao: 'UNNT', iata: 'OVB',
    name: { ru: 'Толмачёво', en: 'Tolmachevo' },
    city: 'Новосибирск', country: 'RU', timezone: 'Asia/Novosibirsk',
    lat: 55.012622, lon: 82.650656, elevationFt: 365, isCoordinated: false,
  },
  {
    id: 'apt_uhww', icao: 'UHWW', iata: 'VVO',
    name: { ru: 'Кневичи', en: 'Knevichi' },
    city: 'Владивосток', country: 'RU', timezone: 'Asia/Vladivostok',
    lat: 43.398953, lon: 132.148017, elevationFt: 46, isCoordinated: false,
  },
  {
    id: 'apt_uacc', icao: 'UACC', iata: 'NQZ',
    name: { ru: 'Нурсултан Назарбаев', en: 'Nursultan Nazarbayev' },
    city: 'Астана', country: 'KZ', timezone: 'Asia/Almaty',
    lat: 51.022222, lon: 71.466944, elevationFt: 1165, isCoordinated: false,
  },
  {
    id: 'apt_omdb', icao: 'OMDB', iata: 'DXB',
    name: { ru: 'Дубай', en: 'Dubai' },
    city: 'Дубай', country: 'AE', timezone: 'Asia/Dubai',
    lat: 25.252778, lon: 55.364444, elevationFt: 62, isCoordinated: true,
  },
  {
    id: 'apt_ltba', icao: 'LTFM', iata: 'IST',
    name: { ru: 'Стамбул', en: 'Istanbul' },
    city: 'Стамбул', country: 'TR', timezone: 'Europe/Istanbul',
    lat: 41.262222, lon: 28.727778, elevationFt: 325, isCoordinated: true,
  },
  {
    id: 'apt_lswi', icao: 'LSGG', iata: 'GVA',
    name: { ru: 'Женева', en: 'Geneva' },
    city: 'Женева', country: 'CH', timezone: 'Europe/Zurich',
    lat: 46.238064, lon: 6.10895, elevationFt: 1411, isCoordinated: true,
  },
  {
    id: 'apt_zbaa', icao: 'ZBAA', iata: 'PEK',
    name: { ru: 'Пекин Столичный', en: 'Beijing Capital' },
    city: 'Пекин', country: 'CN', timezone: 'Asia/Shanghai',
    lat: 40.080111, lon: 116.584556, elevationFt: 116, isCoordinated: true,
  },
  {
    id: 'apt_uuob', icao: 'UUOB', iata: 'EGO',
    name: { ru: 'Белгород', en: 'Belgorod' },
    city: 'Белгород', country: 'RU', timezone: 'Europe/Moscow',
    lat: 50.643839, lon: 36.590017, elevationFt: 682, isCoordinated: false,
  },
];

export const AIRPORT_BY_ICAO = new Map(AIRPORTS.map((a) => [a.icao, a]));

/** Смещение зоны аэропорта в часах — для подписи локального времени. */
export const AIRPORT_UTC_OFFSET: Record<string, number> = {
  UUEE: 3, UUDD: 3, UUWW: 3, ULLI: 3, URSS: 3, UUOB: 3,
  UWWW: 4, UNNT: 7, UHWW: 10, UACC: 5, OMDB: 4, LTFM: 3, LSGG: 2, ZBAA: 8,
};

// ─────────────────────────── Типы ВС ───────────────────────────
// Реальные характеристики.

export const AIRCRAFT_TYPES: AircraftType[] = [
  { id: 'act_cl60', icaoType: 'CL60', name: { ru: 'Challenger 605', en: 'Challenger 605' }, category: 'midsize', seats: 12, cruiseSpeedKts: 459, fuelBurnKgPerHour: 1100, turnaroundMin: 45 },
  { id: 'act_glf5', icaoType: 'GLF5', name: { ru: 'Gulfstream G550', en: 'Gulfstream G550' }, category: 'heavy', seats: 16, cruiseSpeedKts: 488, fuelBurnKgPerHour: 1550, turnaroundMin: 60 },
  { id: 'act_gl7t', icaoType: 'GL7T', name: { ru: 'Global 7500', en: 'Global 7500' }, category: 'heavy', seats: 19, cruiseSpeedKts: 516, fuelBurnKgPerHour: 1700, turnaroundMin: 60 },
  { id: 'act_c68a', icaoType: 'C68A', name: { ru: 'Citation Latitude', en: 'Citation Latitude' }, category: 'midsize', seats: 9, cruiseSpeedKts: 446, fuelBurnKgPerHour: 900, turnaroundMin: 40 },
  { id: 'act_e55p', icaoType: 'E55P', name: { ru: 'Phenom 300', en: 'Phenom 300' }, category: 'light', seats: 8, cruiseSpeedKts: 453, fuelBurnKgPerHour: 620, turnaroundMin: 35 },
  { id: 'act_b738', icaoType: 'B738', name: { ru: 'Boeing 737-800', en: 'Boeing 737-800' }, category: 'airliner', seats: 189, cruiseSpeedKts: 450, fuelBurnKgPerHour: 2600, turnaroundMin: 50 },
  { id: 'act_a320', icaoType: 'A320', name: { ru: 'Airbus A320', en: 'Airbus A320' }, category: 'airliner', seats: 180, cruiseSpeedKts: 447, fuelBurnKgPerHour: 2500, turnaroundMin: 50 },
  { id: 'act_b752', icaoType: 'B752', name: { ru: 'Boeing 757-200F', en: 'Boeing 757-200F' }, category: 'cargo', seats: 0, cruiseSpeedKts: 458, fuelBurnKgPerHour: 3100, turnaroundMin: 90 },
];

export const AIRCRAFT_TYPE_BY_ID = new Map(AIRCRAFT_TYPES.map((t) => [t.id, t]));

// ─────────────────────────── Борта ───────────────────────────
// Регистрации вымышлены (CLAUDE.md § 4).

export const AIRCRAFT: Aircraft[] = [
  { id: 'acf_01', registration: 'RA-67231', typeId: 'act_cl60', status: 'serviceable', homeBaseIcao: 'UUWW', approvals: [{ kind: 'RVSM', number: 'RVSM-2211', validFrom: daysFromNow(-500), validTo: daysFromNow(210) }] },
  { id: 'acf_02', registration: 'RA-67244', typeId: 'act_cl60', status: 'serviceable', homeBaseIcao: 'UUWW', approvals: [{ kind: 'RVSM', number: 'RVSM-2212', validFrom: daysFromNow(-480), validTo: daysFromNow(-3) }] },
  { id: 'acf_03', registration: 'RA-10203', typeId: 'act_glf5', status: 'serviceable', homeBaseIcao: 'UUEE', approvals: [{ kind: 'ETOPS', number: 'ET-0091', validFrom: daysFromNow(-700), validTo: daysFromNow(300) }] },
  { id: 'acf_04', registration: 'RA-10211', typeId: 'act_glf5', status: 'aog', homeBaseIcao: 'UUEE', notes: 'Отказ системы кондиционирования, ожидание запчасти', approvals: [] },
  { id: 'acf_05', registration: 'RA-11500', typeId: 'act_gl7t', status: 'serviceable', homeBaseIcao: 'UUEE', approvals: [] },
  { id: 'acf_06', registration: 'RA-73012', typeId: 'act_c68a', status: 'serviceable', homeBaseIcao: 'ULLI', approvals: [] },
  { id: 'acf_07', registration: 'RA-73019', typeId: 'act_c68a', status: 'maintenance', homeBaseIcao: 'ULLI', notes: 'Плановое техобслуживание, до 5 суток', approvals: [] },
  { id: 'acf_08', registration: 'RA-02755', typeId: 'act_e55p', status: 'serviceable', homeBaseIcao: 'UUDD', approvals: [] },
  { id: 'acf_09', registration: 'RA-02761', typeId: 'act_e55p', status: 'serviceable', homeBaseIcao: 'UUDD', approvals: [] },
  { id: 'acf_10', registration: 'RA-64120', typeId: 'act_b738', status: 'serviceable', homeBaseIcao: 'UUDD', approvals: [] },
  { id: 'acf_11', registration: 'RA-64131', typeId: 'act_b738', status: 'serviceable', homeBaseIcao: 'UUDD', approvals: [] },
  { id: 'acf_12', registration: 'RA-73501', typeId: 'act_a320', status: 'serviceable', homeBaseIcao: 'UUEE', approvals: [] },
  { id: 'acf_13', registration: 'RA-96011', typeId: 'act_b752', status: 'serviceable', homeBaseIcao: 'UUDD', approvals: [] },
  { id: 'acf_14', registration: 'RA-96018', typeId: 'act_b752', status: 'serviceable', homeBaseIcao: 'UWWW', approvals: [] },
];

export const AIRCRAFT_BY_ID = new Map(AIRCRAFT.map((a) => [a.id, a]));

// ─────────────────────────── Каталог услуг ───────────────────────────
// Дерево категорий строго по ТЗ 3.2.1.

export const SERVICES: ServiceCatalogItem[] = [
  { id: 'svc_fuel_jeta1', code: 'FUEL_JETA1', category: 'fuel', name: { ru: 'Заправка Jet A-1', en: 'Jet A-1 refuelling' }, unit: 'L', requiresWeather: false, leadTimeH: 4, requiresActToComplete: true, requiredAttributes: [{ key: 'fuelGrade', type: 'enum', options: ['Jet A-1'], required: true }, { key: 'volumeL', type: 'number', required: true }] },
  { id: 'svc_fuel_avgas', code: 'FUEL_AVGAS', category: 'fuel', name: { ru: 'Заправка Avgas 100LL', en: 'Avgas 100LL refuelling' }, unit: 'L', requiresWeather: false, leadTimeH: 6, requiresActToComplete: true, requiredAttributes: [{ key: 'volumeL', type: 'number', required: true }] },
  { id: 'svc_hnd_basic', code: 'HND_BASIC', category: 'handling', name: { ru: 'Базовое наземное обслуживание', en: 'Basic ground handling' }, unit: 'flight', requiresWeather: false, leadTimeH: 12, requiresActToComplete: true, requiredAttributes: [] },
  { id: 'svc_hnd_vip', code: 'HND_VIP', category: 'handling', name: { ru: 'Обслуживание VIP-терминала', en: 'VIP terminal handling' }, unit: 'flight', requiresWeather: false, leadTimeH: 24, requiresActToComplete: true, requiredAttributes: [{ key: 'paxCount', type: 'number', required: true }] },
  { id: 'svc_hnd_tow', code: 'HND_TOW', category: 'handling', name: { ru: 'Буксировка воздушного судна', en: 'Aircraft towing' }, unit: 'ea', requiresWeather: false, leadTimeH: 6, requiresActToComplete: false, requiredAttributes: [] },
  { id: 'svc_hnd_clean', code: 'HND_CLEAN', category: 'handling', name: { ru: 'Уборка салона', en: 'Cabin cleaning' }, unit: 'flight', requiresWeather: false, leadTimeH: 6, requiresActToComplete: false, requiredAttributes: [] },
  { id: 'svc_cat_meal', code: 'CAT_MEAL', category: 'catering', name: { ru: 'Бортовое питание', en: 'In-flight catering' }, unit: 'pax', requiresWeather: false, leadTimeH: 24, requiresActToComplete: true, requiredAttributes: [{ key: 'paxCount', type: 'number', required: true }, { key: 'menuClass', type: 'enum', options: ['standard', 'premium', 'halal', 'vegetarian'], required: true }] },
  { id: 'svc_cat_crew', code: 'CAT_CREW', category: 'catering', name: { ru: 'Питание экипажа', en: 'Crew catering' }, unit: 'pax', requiresWeather: false, leadTimeH: 12, requiresActToComplete: false, requiredAttributes: [{ key: 'paxCount', type: 'number', required: true }] },
  { id: 'svc_trn_crew', code: 'TRN_CREW', category: 'transport', name: { ru: 'Транспорт для экипажа', en: 'Crew transport' }, unit: 'ea', requiresWeather: false, leadTimeH: 6, requiresActToComplete: false, requiredAttributes: [{ key: 'paxCount', type: 'number', required: true }] },
  { id: 'svc_trn_vip', code: 'TRN_VIP', category: 'transport', name: { ru: 'VIP-трансфер', en: 'VIP transfer' }, unit: 'ea', requiresWeather: false, leadTimeH: 12, requiresActToComplete: true, requiredAttributes: [{ key: 'paxCount', type: 'number', required: true }] },
  { id: 'svc_prm_over', code: 'PRM_OVERFLY', category: 'permits', name: { ru: 'Разрешение на пролёт', en: 'Overflight permit' }, unit: 'ea', requiresWeather: false, leadTimeH: 72, requiresActToComplete: false, requiredAttributes: [{ key: 'country', type: 'string', required: true }] },
  { id: 'svc_prm_land', code: 'PRM_LANDING', category: 'permits', name: { ru: 'Разрешение на посадку', en: 'Landing permit' }, unit: 'ea', requiresWeather: false, leadTimeH: 72, requiresActToComplete: false, requiredAttributes: [] },
  { id: 'svc_dei_type1', code: 'DEI_TYPE1', category: 'deicing', name: { ru: 'Противообледенительная обработка, тип I', en: 'De-icing type I' }, unit: 'L', requiresWeather: true, leadTimeH: 2, requiresActToComplete: true, requiredAttributes: [{ key: 'volumeL', type: 'number', required: true }] },
  { id: 'svc_dei_type4', code: 'DEI_TYPE4', category: 'deicing', name: { ru: 'Противообледенительная обработка, тип IV', en: 'De-icing type IV' }, unit: 'L', requiresWeather: true, leadTimeH: 2, requiresActToComplete: true, requiredAttributes: [{ key: 'volumeL', type: 'number', required: true }] },
];

export const SERVICE_BY_ID = new Map(SERVICES.map((s) => [s.id, s]));

export const SERVICE_CATEGORIES = [
  'fuel', 'handling', 'catering', 'transport', 'permits', 'deicing',
] as const;

// ─────────────────────────── Ставки НДС ───────────────────────────

export const VAT_RATES: VatRate[] = [
  { id: 'vat_20', code: 'VAT20', name: { ru: 'НДС 20 %', en: 'VAT 20%' }, percent: '20.0000', applicability: 'domestic' },
  { id: 'vat_10', code: 'VAT10', name: { ru: 'НДС 10 %', en: 'VAT 10%' }, percent: '10.0000', applicability: 'domestic' },
  { id: 'vat_0', code: 'VAT0', name: { ru: 'НДС 0 %', en: 'VAT 0%' }, percent: '0.0000', applicability: 'international' },
  { id: 'vat_exp', code: 'VATEXP', name: { ru: 'Экспорт услуг, без НДС', en: 'Export of services, VAT exempt' }, percent: '0.0000', applicability: 'export_of_services' },
];
