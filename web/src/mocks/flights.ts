/**
 * Рейсы, заявки на услуги, слоты, конфликты расписания.
 *
 * Набор содержит обязательные «интересные» случаи из `SPEC.md § 11`, без них
 * демонстрация плоская: отказ поставщика с переназначением, нарушение SLA,
 * отрицательная маржа, борт в AOG, конфликт расписания, рейс в валюте,
 * отличной от валюты поставщика.
 *
 * Даты строятся относительно текущей (`CLAUDE.md § 4`), а не как «история за год».
 */
import type {
  Flight,
  FlightListItem,
  FlightRequest,
  FlightStatus,
  FlightTemplate,
  MarginResult,
  ScheduleConflict,
  ServiceOrder,
  Slot,
} from '@/api/types';

import { CLIENTS, CONTRACT_BY_VENDOR, VENDOR_BY_ID, VENDOR_PRICES } from './counterparties';
import {
  AIRCRAFT,
  AIRCRAFT_BY_ID,
  AIRCRAFT_TYPE_BY_ID,
  SERVICE_BY_ID,
  daysFromNow,
  hoursFromNow,
  makeRandom,
  pick,
  required,
} from './reference';

const random = makeRandom(20260913);

const ROUTES: Array<[string, string]> = [
  ['UUWW', 'ULLI'], ['UUEE', 'URSS'], ['UUDD', 'UWWW'], ['UUEE', 'OMDB'],
  ['UUWW', 'LSGG'], ['UUEE', 'LTFM'], ['UUDD', 'UNNT'], ['UNNT', 'UHWW'],
  ['UUEE', 'UACC'], ['UUWW', 'UUOB'], ['ULLI', 'UUEE'], ['UUDD', 'ZBAA'],
];

const FLIGHT_TYPES: Flight['type'][] = ['charter', 'charter', 'charter', 'cargo', 'ferry', 'ambulance', 'technical'];

/** Статус выводится из положения рейса во времени — как это и будет в бою. */
function statusForOffset(offsetHours: number): FlightStatus {
  if (offsetHours < -6) return 'completed';
  if (offsetHours < -2) return 'arrived';
  if (offsetHours < 0) return 'in_flight';
  if (offsetHours < 12) return 'ready_for_departure';
  if (offsetHours < 72) return 'in_work';
  return 'planned';
}

function haversineNm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return (6371 * 2 * Math.asin(Math.sqrt(h))) / 1.852;
}

import { AIRPORT_BY_ICAO } from './reference';

interface BuiltFlight {
  flight: Flight;
  orders: ServiceOrder[];
  margin: MarginResult;
}

const FX_SNAPSHOT = {
  date: daysFromNow(0),
  base: 'RUB' as const,
  rates: { RUB: '1', USD: '92.4500', EUR: '100.1200' },
  policy: 'document_date' as const,
  source: 'synthetic' as const,
  staleSince: null,
};

function money(amount: number, currency: 'RUB' | 'USD' | 'EUR') {
  return { amount: amount.toFixed(4), currency };
}

function buildOrders(flight: Flight, index: number): ServiceOrder[] {
  const orders: ServiceOrder[] = [];
  const legs: Array<'departure' | 'arrival'> = ['departure', 'arrival'];

  // Набор услуг зависит от типа рейса — как и в жизни.
  const serviceIds =
    flight.type === 'cargo'
      ? ['svc_hnd_basic', 'svc_fuel_jeta1']
      : flight.type === 'ambulance'
        ? ['svc_hnd_basic', 'svc_fuel_jeta1', 'svc_trn_crew']
        : ['svc_hnd_basic', 'svc_fuel_jeta1', 'svc_cat_meal', 'svc_trn_crew'];

  let seq = 0;
  for (const leg of legs) {
    const icao = leg === 'departure' ? flight.depIcao : flight.arrIcao;
    for (const serviceId of serviceIds) {
      if (leg === 'arrival' && serviceId !== 'svc_hnd_basic') continue;
      seq += 1;

      const price = VENDOR_PRICES.find((p) => p.serviceId === serviceId && p.airportIcao === icao)
        ?? VENDOR_PRICES.find((p) => p.serviceId === serviceId);
      if (!price) continue;

      const service = SERVICE_BY_ID.get(serviceId);
      const quantity = serviceId === 'svc_fuel_jeta1'
        ? String(Math.round(flight.fuelPlanKg ?? 3000))
        : serviceId === 'svc_cat_meal'
          ? String(flight.paxCount)
          : '1';

      const unit = Number.parseFloat(price.price.amount);
      const cost = unit * Number.parseFloat(quantity);
      const markup = flight.billingCurrency === price.price.currency ? 1.18 : 1.12;

      // Статус заявки согласован со статусом рейса: несогласованность
      // выглядела бы как ошибка системы, а не как демонстрация.
      let status: ServiceOrder['status'] = 'confirmed';
      if (flight.status === 'planned') status = 'draft';
      else if (flight.status === 'in_work') status = seq % 3 === 0 ? 'ordered' : 'confirmed';
      else if (flight.status === 'completed' || flight.status === 'arrived') status = 'completed';

      const slaBreached = index === 4 && seq === 2;
      const rejected = index === 2 && seq === 3;

      orders.push({
        id: `so_${flight.id.slice(-3)}_${String(seq).padStart(2, '0')}`,
        flightId: flight.id,
        serviceId,
        service: service ?? undefined,
        leg,
        airportIcao: icao,
        vendorId: price.vendorId,
        vendorName: VENDOR_BY_ID.get(price.vendorId)?.name ?? '',
        contractId: CONTRACT_BY_VENDOR.get(price.vendorId)?.id ?? null,
        status: rejected ? 'rejected' : status,
        availableTransitions: status === 'ordered' ? ['confirm', 'reject', 'cancel'] : [],
        quantity,
        actualQuantity: status === 'completed'
          ? String(Math.round(Number.parseFloat(quantity) * (serviceId === 'svc_fuel_jeta1' ? 1.03 : 1)))
          : null,
        attributes: serviceId === 'svc_fuel_jeta1'
          ? { fuelGrade: 'Jet A-1', volumeL: Number.parseFloat(quantity) }
          : serviceId === 'svc_cat_meal'
            ? { paxCount: flight.paxCount, menuClass: 'standard' }
            : {},
        purchasePrice: price.price,
        actualPurchaseUnitPrice: null,
        purchaseSurcharges: price.surcharges,
        purchaseCost: money(cost, price.price.currency),
        salePrice: money(cost * markup, flight.billingCurrency),
        tariffRuleId: 'trf_001',
        contractTermsSnapshot: {
          currency: price.price.currency,
          mode: 'deferred',
          deferDays: VENDOR_BY_ID.get(price.vendorId)?.paymentTerms?.deferDays ?? 30,
        },
        orderedAt: status === 'draft' ? null : hoursFromNow(-48 - seq),
        confirmedAt: status === 'draft' || status === 'ordered' ? null : hoursFromNow(-40 - seq),
        startedAt: status === 'completed' ? hoursFromNow(-8) : null,
        completedAt: status === 'completed' ? hoursFromNow(-6) : null,
        actualStartAt: status === 'completed' ? hoursFromNow(-8) : null,
        actualEndAt: status === 'completed' ? hoursFromNow(-6) : null,
        slaConfirmDeadline: hoursFromNow(slaBreached ? -30 : 6),
        slaBreached,
        rejectionReason: rejected ? 'Нет свободного экипажа на запрошенное время' : null,
        replacedOrderId: null,
        documents: status === 'completed'
          ? [{
              id: `att_${flight.id.slice(-3)}_${seq}`,
              fileName: `Акт_${flight.number}_${seq}.pdf`,
              mimeType: 'application/pdf',
              sizeBytes: 148_320,
              kind: 'act',
              storageKey: `acts/${flight.id}/${seq}.pdf`,
              uploadedAt: hoursFromNow(-5),
              uploadedBy: 'usr_disp1',
            }]
          : [],
        dataSource: 'synthetic',
        isDemo: true,
      });
    }
  }

  // Переназначение после отказа: новая заявка со ссылкой на прежнюю.
  const rejectedOrder = orders.find((o) => o.status === 'rejected');
  if (rejectedOrder) {
    orders.push({
      ...rejectedOrder,
      id: `${rejectedOrder.id}_r`,
      status: 'confirmed',
      vendorId: 'ven_006',
      vendorName: VENDOR_BY_ID.get('ven_006')?.name ?? '',
      rejectionReason: null,
      replacedOrderId: rejectedOrder.id,
      slaBreached: false,
      availableTransitions: ['begin', 'cancel'],
    });
  }

  return orders;
}

function buildMargin(flight: Flight, orders: ServiceOrder[], negative: boolean): MarginResult {
  const active = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'rejected');
  const rates: Record<string, string> = FX_SNAPSHOT.rates;
  const rate = (currency: string) => Number.parseFloat(rates[currency] ?? '1');
  const target = rate(flight.billingCurrency);

  const revenue = active.reduce(
    (sum, o) => sum + Number.parseFloat(o.salePrice?.amount ?? '0'),
    0,
  );
  const cost = active.reduce(
    (sum, o) => sum + (Number.parseFloat(o.purchaseCost?.amount ?? '0') * rate(o.purchaseCost?.currency ?? 'RUB')) / target,
    0,
  );

  const adjustedCost = negative ? revenue * 1.14 : cost;
  const margin = revenue - adjustedCost;
  const percent = revenue === 0 ? null : ((margin / revenue) * 100).toFixed(4);

  const mode: MarginResult['mode'] =
    flight.status === 'completed' ? 'fact' : flight.status === 'planned' ? 'plan' : 'mixed';

  return {
    mode,
    currency: flight.billingCurrency,
    revenue: money(revenue, flight.billingCurrency),
    cost: money(adjustedCost, flight.billingCurrency),
    margin: money(margin, flight.billingCurrency),
    marginPercent: percent,
    planPortionPercent: mode === 'mixed' ? '40.0000' : null,
    isBelowThreshold: percent !== null && Number.parseFloat(percent) < 12,
    thresholdPercent: '12.0000',
    fx: FX_SNAPSHOT,
    calculatedAt: daysFromNow(0),
  };
}

// ─────────────────────────── Построение набора ───────────────────────────

const built: BuiltFlight[] = [];

for (let index = 0; index < 56; index += 1) {
  // Рейсы от −7 до +14 суток от текущего момента.
  const offsetHours = Math.round((index - 18) * 9 + random() * 6);
  const route = required(ROUTES[index % ROUTES.length], 'маршрут');
  const client = required(CLIENTS[index % 7], 'клиент');
  const aircraft = required(AIRCRAFT[index % AIRCRAFT.length], 'борт');
  const type = AIRCRAFT_TYPE_BY_ID.get(aircraft.typeId);

  const dep = AIRPORT_BY_ICAO.get(route[0]);
  const arr = AIRPORT_BY_ICAO.get(route[1]);
  const distanceNm = dep && arr
    ? Math.round(haversineNm([dep.lat, dep.lon], [arr.lat, arr.lon]))
    : 800;
  const blockTimeMin = Math.round((distanceNm / (type?.cruiseSpeedKts ?? 450)) * 60 + 20);

  const std = new Date(Date.now() + offsetHours * 3_600_000);
  std.setUTCMinutes(Math.floor(std.getUTCMinutes() / 5) * 5, 0, 0);
  const sta = new Date(std.getTime() + blockTimeMin * 60_000);

  const status = statusForOffset(offsetHours);
  const isInternational = dep?.country !== arr?.country;

  const flight: Flight = {
    id: `flt_${String(index + 1).padStart(3, '0')}`,
    number: `SLG-${1000 + index * 7}`,
    clientId: client.id,
    // Один рейс намеренно без борта — строка «Без борта» на планшете (SPEC § 4.1).
    aircraftId: index === 9 ? null : aircraft.id,
    type: pick(random, FLIGHT_TYPES),
    depIcao: route[0],
    arrIcao: route[1],
    stdUtc: std.toISOString(),
    staUtc: sta.toISOString(),
    atdUtc: status === 'completed' || status === 'arrived' || status === 'in_flight'
      ? new Date(std.getTime() + 4 * 60_000).toISOString()
      : null,
    ataUtc: status === 'completed' || status === 'arrived'
      ? new Date(sta.getTime() + 7 * 60_000).toISOString()
      : null,
    status,
    availableTransitions:
      status === 'planned' ? ['start', 'cancel']
        : status === 'in_work' ? ['ready', 'cancel', 'aog']
          : status === 'ready_for_departure' ? ['depart', 'cancel', 'aog']
            : status === 'in_flight' ? ['arrive']
              : status === 'arrived' ? ['complete']
                : [],
    blockedTransitions:
      status === 'in_work'
        ? [{ transition: 'ready', unmetConditions: ['all_orders_confirmed_or_completed'] }]
        : [],
    statusReason: null,
    isInternational,
    paxCount: type?.seats ? Math.max(2, Math.round(type.seats * 0.5)) : 6,
    crew: [
      { id: `crw_${index}_1`, name: 'Соловьёв А. В.', role: 'PIC', licenseNo: 'PL-104488' },
      { id: `crw_${index}_2`, name: 'Гаврилов Д. И.', role: 'SIC', licenseNo: 'PL-118902' },
    ],
    distanceNm,
    blockTimeMin,
    fuelPlanKg: Math.round(((blockTimeMin / 60) * (type?.fuelBurnKgPerHour ?? 1000)) * 1.1),
    billingCurrency: client.settlementCurrency,
    fxSnapshot: FX_SNAPSHOT,
    templateId: index % 11 === 0 ? 'tpl_001' : null,
    remarks: null,
    dataSource: 'synthetic',
    isDemo: true,
    createdAt: daysFromNow(-20),
    updatedAt: daysFromNow(-1),
  };

  const orders = buildOrders(flight, index);
  // Рейс с отрицательной маржой — обязательный случай SPEC § 11.
  const margin = buildMargin(flight, orders, index === 6);

  built.push({ flight, orders, margin });
}

// Борт в AOG: его ближайший рейс тоже в AOG (ADR-009 — это следствие, а не то же самое).
const aogFlight = built.find((b) => b.flight.aircraftId === 'acf_04' && b.flight.status === 'in_work');
if (aogFlight) {
  aogFlight.flight.status = 'aog';
  aogFlight.flight.statusReason = {
    code: 'technical',
    comment: 'Отказ системы кондиционирования, ожидание запчасти',
  };
  aogFlight.flight.availableTransitions = ['resume', 'cancel'];
}

// Конфликт расписания: рейс на том же борту, пересекающийся по времени.
const conflictBase = built[24]?.flight;
if (conflictBase) {
  const clone = built[25]?.flight;
  if (clone) {
    clone.aircraftId = conflictBase.aircraftId;
    clone.stdUtc = new Date(new Date(conflictBase.stdUtc).getTime() + 30 * 60_000).toISOString();
    clone.staUtc = new Date(new Date(conflictBase.staUtc).getTime() + 30 * 60_000).toISOString();
  }
}

export const FLIGHTS: Flight[] = built.map((b) => b.flight);
export const SERVICE_ORDERS: ServiceOrder[] = built.flatMap((b) => b.orders);
export const MARGINS = new Map(built.map((b) => [b.flight.id, b.margin]));
export const FLIGHT_BY_ID = new Map(FLIGHTS.map((f) => [f.id, f]));

export function ordersForFlight(flightId: string): ServiceOrder[] {
  return SERVICE_ORDERS.filter((o) => o.flightId === flightId);
}

export const FLIGHT_LIST: FlightListItem[] = built.map(({ flight, orders, margin }) => ({
  id: flight.id,
  number: flight.number,
  clientId: flight.clientId,
  clientName: CLIENTS.find((c) => c.id === flight.clientId)?.name ?? '',
  aircraftId: flight.aircraftId ?? null,
  aircraftRegistration: flight.aircraftId
    ? (AIRCRAFT_BY_ID.get(flight.aircraftId)?.registration ?? null)
    : null,
  type: flight.type,
  depIcao: flight.depIcao,
  arrIcao: flight.arrIcao,
  stdUtc: flight.stdUtc,
  staUtc: flight.staUtc,
  status: flight.status,
  unconfirmedServicesCount: orders.filter((o) => o.status === 'ordered' || o.status === 'draft').length,
  marginPercent: margin.marginPercent,
  hasConflicts: flight.id === 'flt_025' || flight.id === 'flt_026',
  isDemo: true,
}));

// ─────────────────────────── Конфликты ───────────────────────────

export const CONFLICTS: ScheduleConflict[] = [
  {
    kind: 'overlap', flightId: 'flt_026', relatedFlightId: 'flt_025',
    aircraftId: FLIGHT_BY_ID.get('flt_026')?.aircraftId ?? null,
    message: 'Пересечение с рейсом SLG-1168 на том же борту',
    severity: 'warning',
  },
  {
    kind: 'turnaround', flightId: 'flt_026', relatedFlightId: 'flt_025',
    aircraftId: FLIGHT_BY_ID.get('flt_026')?.aircraftId ?? null,
    message: 'Между рейсами менее 45 минут, минимум для типа CL60',
    severity: 'warning',
  },
  {
    kind: 'aircraft_unserviceable',
    flightId: built.find((b) => b.flight.aircraftId === 'acf_04')?.flight.id ?? 'flt_004',
    relatedFlightId: null, aircraftId: 'acf_04',
    message: 'Борт RA-10211 в состоянии AOG',
    severity: 'blocking',
  },
  {
    kind: 'expired_approval',
    flightId: built.find((b) => b.flight.aircraftId === 'acf_02')?.flight.id ?? 'flt_002',
    relatedFlightId: null, aircraftId: 'acf_02',
    message: 'Допуск RVSM борта RA-67244 истёк 3 дня назад',
    severity: 'blocking',
  },
];

// ─────────────────────────── Шаблоны ───────────────────────────

export const FLIGHT_TEMPLATES: FlightTemplate[] = [
  {
    id: 'tpl_001', name: 'Москва — Санкт-Петербург, будни', clientId: 'cli_001',
    aircraftTypeId: 'act_cl60', depIcao: 'UUWW', arrIcao: 'ULLI',
    depTimeLocal: '08:30', weekdays: [1, 2, 3, 4, 5],
    defaultServices: [
      { serviceId: 'svc_hnd_basic', leg: 'departure', attributes: {} },
      { serviceId: 'svc_fuel_jeta1', leg: 'departure', attributes: { fuelGrade: 'Jet A-1' } },
      { serviceId: 'svc_hnd_basic', leg: 'arrival', attributes: {} },
    ],
  },
  {
    id: 'tpl_002', name: 'Москва — Сочи, выходные', clientId: 'cli_002',
    aircraftTypeId: 'act_c68a', depIcao: 'UUEE', arrIcao: 'URSS',
    depTimeLocal: '10:00', weekdays: [6, 7],
    defaultServices: [{ serviceId: 'svc_hnd_basic', leg: 'departure', attributes: {} }],
  },
  {
    id: 'tpl_003', name: 'Грузовой Домодедово — Новосибирск', clientId: 'cli_006',
    aircraftTypeId: 'act_b752', depIcao: 'UUDD', arrIcao: 'UNNT',
    depTimeLocal: '23:40', weekdays: [2, 4, 6],
    defaultServices: [
      { serviceId: 'svc_hnd_basic', leg: 'departure', attributes: {} },
      { serviceId: 'svc_fuel_jeta1', leg: 'departure', attributes: {} },
    ],
  },
];

// ─────────────────────────── Заявки клиентов ───────────────────────────

export const FLIGHT_REQUESTS: FlightRequest[] = [
  { id: 'req_001', clientId: 'cli_001', depIcao: 'UUWW', arrIcao: 'URSS', requestedStdUtc: daysFromNow(5, 7, 30), paxCount: 6, comment: 'Просим борт с салоном на 8 мест', status: 'pending', createdFlightId: null, rejectionReason: null, createdAt: daysFromNow(-1) },
  { id: 'req_002', clientId: 'cli_003', depIcao: 'OMDB', arrIcao: 'UUEE', requestedStdUtc: daysFromNow(8, 4, 0), paxCount: 11, comment: 'VIP handling on departure required', status: 'pending', createdFlightId: null, rejectionReason: null, createdAt: hoursFromNow(-6) },
  { id: 'req_003', clientId: 'cli_004', depIcao: 'LSGG', arrIcao: 'UUWW', requestedStdUtc: daysFromNow(11, 9, 15), paxCount: 4, comment: '', status: 'approved', createdFlightId: 'flt_040', rejectionReason: null, createdAt: daysFromNow(-4) },
  { id: 'req_004', clientId: 'cli_002', depIcao: 'UUEE', arrIcao: 'ZBAA', requestedStdUtc: daysFromNow(2, 3, 0), paxCount: 9, comment: '', status: 'rejected', createdFlightId: null, rejectionReason: 'Нет свободного борта с необходимой дальностью на указанную дату', createdAt: daysFromNow(-3) },
];

// ─────────────────────────── Слоты ───────────────────────────
// ADR-026: публичного подключения к слот-координации не существует,
// реестр ведётся вручную.

export const SLOTS: Slot[] = [
  { id: 'slt_001', airportIcao: 'UUEE', flightId: 'flt_004', kind: 'departure', requestedTimeUtc: daysFromNow(1, 6, 40), confirmedTimeUtc: daysFromNow(1, 6, 55), status: 'confirmed', messageRef: 'SCR/2026/0914-001', comment: null },
  { id: 'slt_002', airportIcao: 'OMDB', flightId: 'flt_004', kind: 'arrival', requestedTimeUtc: daysFromNow(1, 12, 10), confirmedTimeUtc: null, status: 'requested', messageRef: 'SCR/2026/0914-002', comment: 'Отправлено координатору, ответа нет' },
  { id: 'slt_003', airportIcao: 'LTFM', flightId: 'flt_006', kind: 'arrival', requestedTimeUtc: daysFromNow(3, 15, 25), confirmedTimeUtc: null, status: 'rejected', messageRef: 'SCR/2026/0916-004', comment: 'Слот занят, предложено 16:40Z' },
  { id: 'slt_004', airportIcao: 'LSGG', flightId: 'flt_005', kind: 'arrival', requestedTimeUtc: daysFromNow(2, 11, 0), confirmedTimeUtc: daysFromNow(2, 11, 0), status: 'confirmed', messageRef: 'SCR/2026/0915-003', comment: null },
];
