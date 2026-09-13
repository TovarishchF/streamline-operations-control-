import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type {
  Flight,
  FlightListItem,
  FlightRequest,
  FlightStatus,
  FlightTransition,
  MessageTemplate,
  ServiceOrder,
  ServiceOrderStatus,
  ServiceOrderTransition,
} from '@/api/types';
import flightMachine from '@shared/state-machines/flight.json';
import orderMachine from '@shared/state-machines/service-order.json';

import { MESSAGE_TEMPLATES } from './comms';
import { CLIENTS, CONTRACT_BY_VENDOR, VENDOR_BY_ID, VENDOR_PRICES } from './counterparties';
import {
  FLIGHTS,
  FLIGHT_REQUESTS,
  MARGINS,
  SERVICE_ORDERS,
} from './flights';
import {
  AIRCRAFT_BY_ID,
  AIRCRAFT_TYPE_BY_ID,
  AIRPORT_BY_ICAO,
  SERVICE_BY_ID,
} from './reference';

/**
 * Рабочее состояние прототипа.
 *
 * На M2 сервера ещё нет, но кнопки должны **действительно** что-то делать:
 * созданный рейс появляется в расписании, переход статуса меняет статус,
 * заказанная услуга встаёт в список. Иначе заказчик утверждает не интерфейс,
 * а картинку.
 *
 * Ограничения этого слоя, снимаемые на M10:
 * — данные живут в браузере (`localStorage`), а не в базе;
 * — переходы проверяются против `shared/state-machines/*.json`, но guard-ы
 *   реализованы упрощённо: полный набор условий — на сервере (`DOMAIN.md § 5`);
 * — суммы пересчитываются грубо: канонический расчёт маржи принадлежит серверу
 *   (`CLAUDE.md § 3` п. 16, ADR-012).
 *
 * Файл целиком заменяется вызовами API на вехе M10.
 */

interface Transition {
  name: string;
  from: string[];
  to: string;
}

const FLIGHT_TRANSITIONS = flightMachine.transitions as Transition[];
const ORDER_TRANSITIONS = orderMachine.transitions as Transition[];

/** Переходы, доступные из состояния по определению автомата. */
function availableFrom(transitions: Transition[], status: string): string[] {
  return transitions.filter((item) => item.from.includes(status)).map((item) => item.name);
}

function targetOf(transitions: Transition[], name: string, status: string): string | null {
  const transition = transitions.find((item) => item.name === name && item.from.includes(status));
  return transition ? transition.to : null;
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function haversineNm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return (6371 * 2 * Math.asin(Math.sqrt(h))) / 1.852;
}

export interface CreateFlightInput {
  clientId: string;
  aircraftId?: string | undefined;
  type: Flight['type'];
  depIcao: string;
  arrIcao: string;
  stdUtc: string;
  paxCount: number;
  remarks?: string | undefined;
}

export interface CreateOrderInput {
  flightId: string;
  serviceId: string;
  leg: 'departure' | 'arrival';
  quantity: string;
  vendorId: string;
}

interface StoreState {
  flights: Flight[];
  orders: ServiceOrder[];
  requests: FlightRequest[];
  templates: MessageTemplate[];
  /** Номер для следующего созданного рейса. */
  nextFlightSeq: number;

  createFlight: (input: CreateFlightInput) => Flight;
  updateFlight: (id: string, patch: Partial<Flight>) => void;
  transitionFlight: (id: string, transition: FlightTransition, reason?: { code: string; comment: string }) => string | null;

  createOrder: (input: CreateOrderInput) => ServiceOrder | null;
  transitionOrder: (id: string, transition: ServiceOrderTransition) => string | null;
  reassignOrder: (id: string, vendorId: string) => void;

  approveRequest: (id: string) => Flight | null;
  rejectRequest: (id: string, reason: string) => void;
  createRequest: (input: Omit<FlightRequest, 'id' | 'status' | 'createdFlightId' | 'rejectionReason' | 'createdAt'>) => void;

  saveTemplate: (code: string, patch: Pick<MessageTemplate, 'subject' | 'body'>) => void;

  reset: () => void;
}

const FX_RATES: Record<string, string> = { RUB: '1', USD: '92.4500', EUR: '100.1200' };

function computeFlightDerived(
  depIcao: string,
  arrIcao: string,
  stdUtc: string,
  aircraftId: string | undefined,
): Pick<Flight, 'staUtc' | 'distanceNm' | 'blockTimeMin' | 'fuelPlanKg' | 'isInternational'> {
  const from = AIRPORT_BY_ICAO.get(depIcao);
  const to = AIRPORT_BY_ICAO.get(arrIcao);
  const aircraft = aircraftId ? AIRCRAFT_BY_ID.get(aircraftId) : undefined;
  const type = aircraft ? AIRCRAFT_TYPE_BY_ID.get(aircraft.typeId) : undefined;

  const distanceNm =
    from && to ? Math.round(haversineNm([from.lat, from.lon], [to.lat, to.lon])) : 800;
  const blockTimeMin = Math.round((distanceNm / (type?.cruiseSpeedKts ?? 450)) * 60 + 20);

  return {
    staUtc: new Date(new Date(stdUtc).getTime() + blockTimeMin * 60_000).toISOString(),
    distanceNm,
    blockTimeMin,
    fuelPlanKg: Math.round((blockTimeMin / 60) * (type?.fuelBurnKgPerHour ?? 1000) * 1.1),
    isInternational: from?.country !== to?.country,
  };
}

export const useSocStore = create<StoreState>()(
  persist(
    (set, get) => ({
      flights: FLIGHTS,
      orders: SERVICE_ORDERS,
      requests: FLIGHT_REQUESTS,
      templates: MESSAGE_TEMPLATES,
      nextFlightSeq: 1,

      // ─────────────────────────── Рейсы ───────────────────────────

      createFlight: (input) => {
        const seq = get().nextFlightSeq;
        const derived = computeFlightDerived(
          input.depIcao,
          input.arrIcao,
          input.stdUtc,
          input.aircraftId,
        );
        const client = CLIENTS.find((c) => c.id === input.clientId);
        const nowIso = new Date().toISOString();

        const flight: Flight = {
          id: makeId('flt'),
          number: `SLG-${String(2000 + seq)}`,
          clientId: input.clientId,
          aircraftId: input.aircraftId ?? null,
          type: input.type,
          depIcao: input.depIcao,
          arrIcao: input.arrIcao,
          stdUtc: input.stdUtc,
          atdUtc: null,
          ataUtc: null,
          // Новый рейс начинает жизнь в «Запланирован» (DOMAIN § 5.1)
          status: 'planned',
          availableTransitions: availableFrom(FLIGHT_TRANSITIONS, 'planned') as FlightTransition[],
          blockedTransitions: [],
          statusReason: null,
          paxCount: input.paxCount,
          crew: [],
          billingCurrency: client?.settlementCurrency ?? 'RUB',
          fxSnapshot: {
            date: nowIso,
            base: 'RUB',
            rates: FX_RATES,
            policy: 'document_date',
            source: 'user',
            staleSince: null,
          },
          templateId: null,
          remarks: input.remarks ?? null,
          // Запись введена пользователем, а не сгенерирована (CLAUDE.md § 4)
          dataSource: 'user',
          isDemo: false,
          createdAt: nowIso,
          updatedAt: nowIso,
          ...derived,
        };

        set((state) => ({ flights: [flight, ...state.flights], nextFlightSeq: seq + 1 }));
        return flight;
      },

      updateFlight: (id, patch) => {
        set((state) => ({
          flights: state.flights.map((flight) => {
            if (flight.id !== id) return flight;
            const merged = { ...flight, ...patch, updatedAt: new Date().toISOString() };
            // Маршрут или время изменились — производные величины пересчитываются
            if (patch.depIcao ?? patch.arrIcao ?? patch.stdUtc ?? patch.aircraftId) {
              Object.assign(
                merged,
                computeFlightDerived(
                  merged.depIcao,
                  merged.arrIcao,
                  merged.stdUtc,
                  merged.aircraftId ?? undefined,
                ),
              );
            }
            return merged;
          }),
        }));
      },

      /**
       * Переход статуса рейса.
       *
       * Возвращает код невыполненного условия или `null` при успехе.
       * Статус не присваивается напрямую (`CLAUDE.md § 3` п. 3) — только
       * через переход, существующий в определении автомата.
       */
      transitionFlight: (id, transition, reason) => {
        const flight = get().flights.find((item) => item.id === id);
        if (!flight) return 'not_found';

        const target = targetOf(FLIGHT_TRANSITIONS, transition, flight.status);
        if (!target) return 'transition_not_allowed';

        const orders = get().orders.filter((order) => order.flightId === id);

        // Guard-ы из DOMAIN § 5.1. Полный набор — на сервере (M4).
        if (transition === 'start') {
          if (!flight.aircraftId) return 'aircraft_assigned';
          if (orders.length === 0) return 'has_at_least_one_service_order';
        }
        if (transition === 'ready') {
          if (orders.some((order) => order.status === 'rejected')) return 'no_rejected_orders';
          if (!orders.every((order) => order.status === 'confirmed' || order.status === 'completed')) {
            return 'all_orders_confirmed_or_completed';
          }
        }
        if (transition === 'complete') {
          if (!orders.every((order) => order.status === 'completed' || order.status === 'cancelled')) {
            return 'all_orders_completed_or_cancelled';
          }
        }
        if ((transition === 'cancel' || transition === 'aog') && !reason?.comment) {
          return 'reason_provided';
        }

        const nowIso = new Date().toISOString();

        set((state) => ({
          flights: state.flights.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: target as FlightStatus,
                  availableTransitions: availableFrom(FLIGHT_TRANSITIONS, target) as FlightTransition[],
                  blockedTransitions: [],
                  statusReason: reason ?? item.statusReason,
                  atdUtc: transition === 'depart' ? nowIso : item.atdUtc,
                  ataUtc: transition === 'arrive' ? nowIso : item.ataUtc,
                  updatedAt: nowIso,
                }
              : item,
          ),
          // Каскадная отмена заявок при отмене рейса (DOMAIN § 5.1)
          orders:
            transition === 'cancel'
              ? state.orders.map((order) =>
                  order.flightId === id && order.status !== 'completed'
                    ? { ...order, status: 'cancelled' as ServiceOrderStatus, availableTransitions: [] }
                    : order,
                )
              : state.orders,
        }));

        return null;
      },

      // ─────────────────────────── Заявки на услуги ───────────────────────────

      createOrder: (input) => {
        const flight = get().flights.find((item) => item.id === input.flightId);
        if (!flight) return null;

        const airportIcao = input.leg === 'departure' ? flight.depIcao : flight.arrIcao;
        const price =
          VENDOR_PRICES.find(
            (item) =>
              item.vendorId === input.vendorId &&
              item.serviceId === input.serviceId &&
              item.airportIcao === airportIcao,
          ) ?? VENDOR_PRICES.find((item) => item.vendorId === input.vendorId);
        if (!price) return null;

        const quantity = Number.parseFloat(input.quantity) || 1;
        const unit = Number.parseFloat(price.price.amount);
        const cost = unit * quantity;
        const markup = flight.billingCurrency === price.price.currency ? 1.18 : 1.12;
        const nowIso = new Date().toISOString();
        const vendor = VENDOR_BY_ID.get(input.vendorId);

        const order: ServiceOrder = {
          id: makeId('so'),
          flightId: input.flightId,
          serviceId: input.serviceId,
          service: SERVICE_BY_ID.get(input.serviceId),
          leg: input.leg,
          airportIcao,
          vendorId: input.vendorId,
          vendorName: vendor?.name ?? '',
          contractId: CONTRACT_BY_VENDOR.get(input.vendorId)?.id ?? null,
          // Заказ сразу уходит поставщику: переход order из автомата заявки
          status: 'ordered',
          availableTransitions: availableFrom(ORDER_TRANSITIONS, 'ordered') as ServiceOrderTransition[],
          quantity: input.quantity,
          actualQuantity: null,
          attributes: {},
          // Снимок цены на момент назначения (CLAUDE.md § 3 п. 5)
          purchasePrice: price.price,
          actualPurchaseUnitPrice: null,
          purchaseSurcharges: price.surcharges,
          purchaseCost: { amount: cost.toFixed(4), currency: price.price.currency },
          salePrice: { amount: (cost * markup).toFixed(4), currency: flight.billingCurrency },
          tariffRuleId: 'trf_001',
          contractTermsSnapshot: {
            currency: price.price.currency,
            mode: 'deferred',
            deferDays: vendor?.paymentTerms?.deferDays ?? 30,
          },
          orderedAt: nowIso,
          confirmedAt: null,
          startedAt: null,
          completedAt: null,
          actualStartAt: null,
          actualEndAt: null,
          slaConfirmDeadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
          slaBreached: false,
          rejectionReason: null,
          replacedOrderId: null,
          documents: [],
          dataSource: 'user',
          isDemo: false,
        };

        set((state) => ({ orders: [...state.orders, order] }));
        return order;
      },

      transitionOrder: (id, transition) => {
        const order = get().orders.find((item) => item.id === id);
        if (!order) return 'not_found';

        const target = targetOf(ORDER_TRANSITIONS, transition, order.status);
        if (!target) return 'transition_not_allowed';

        const nowIso = new Date().toISOString();

        set((state) => ({
          orders: state.orders.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: target as ServiceOrderStatus,
                  availableTransitions: availableFrom(
                    ORDER_TRANSITIONS,
                    target,
                  ) as ServiceOrderTransition[],
                  confirmedAt: transition === 'confirm' ? nowIso : item.confirmedAt,
                  startedAt: transition === 'begin' ? nowIso : item.startedAt,
                  completedAt: transition === 'finish' ? nowIso : item.completedAt,
                  actualStartAt: transition === 'finish' ? (item.startedAt ?? nowIso) : item.actualStartAt,
                  actualEndAt: transition === 'finish' ? nowIso : item.actualEndAt,
                  actualQuantity: transition === 'finish' ? (item.actualQuantity ?? item.quantity) : item.actualQuantity,
                }
              : item,
          ),
        }));

        return null;
      },

      reassignOrder: (id, vendorId) => {
        const order = get().orders.find((item) => item.id === id);
        if (!order) return;

        const price =
          VENDOR_PRICES.find(
            (item) =>
              item.vendorId === vendorId &&
              item.serviceId === order.serviceId &&
              item.airportIcao === order.airportIcao,
          ) ?? VENDOR_PRICES.find((item) => item.vendorId === vendorId);

        const vendor = VENDOR_BY_ID.get(vendorId);
        const quantity = Number.parseFloat(order.quantity) || 1;
        const unit = price ? Number.parseFloat(price.price.amount) : 0;

        const replacement: ServiceOrder = {
          ...order,
          id: makeId('so'),
          vendorId,
          vendorName: vendor?.name ?? '',
          contractId: CONTRACT_BY_VENDOR.get(vendorId)?.id ?? null,
          status: 'ordered',
          availableTransitions: availableFrom(ORDER_TRANSITIONS, 'ordered') as ServiceOrderTransition[],
          // Новый снимок цены: переназначение — это новая договорённость
          purchasePrice: price?.price ?? order.purchasePrice,
          purchaseCost: price
            ? { amount: (unit * quantity).toFixed(4), currency: price.price.currency }
            : order.purchaseCost,
          rejectionReason: null,
          slaBreached: false,
          replacedOrderId: order.id,
          orderedAt: new Date().toISOString(),
          confirmedAt: null,
          dataSource: 'user',
          isDemo: false,
        };

        set((state) => ({ orders: [...state.orders, replacement] }));
      },

      // ─────────────────────────── Заявки клиентов ───────────────────────────

      approveRequest: (id) => {
        const request = get().requests.find((item) => item.id === id);
        if (!request || request.status !== 'pending') return null;

        const client = CLIENTS.find((item) => item.id === request.clientId);
        const flight = get().createFlight({
          clientId: request.clientId,
          type: 'charter',
          depIcao: request.depIcao,
          arrIcao: request.arrIcao,
          stdUtc: request.requestedStdUtc,
          paxCount: request.paxCount ?? 0,
          remarks: request.comment
            ? `Из заявки клиента ${client?.name ?? ''}: ${request.comment}`
            : undefined,
        });

        set((state) => ({
          requests: state.requests.map((item) =>
            item.id === id ? { ...item, status: 'approved', createdFlightId: flight.id } : item,
          ),
        }));

        return flight;
      },

      rejectRequest: (id, reason) => {
        set((state) => ({
          requests: state.requests.map((item) =>
            item.id === id ? { ...item, status: 'rejected', rejectionReason: reason } : item,
          ),
        }));
      },

      createRequest: (input) => {
        const request: FlightRequest = {
          ...input,
          id: makeId('req'),
          status: 'pending',
          createdFlightId: null,
          rejectionReason: null,
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ requests: [request, ...state.requests] }));
      },

      // ─────────────────────────── Шаблоны сообщений ───────────────────────────

      saveTemplate: (code, patch) => {
        set((state) => ({
          templates: state.templates.map((template) =>
            template.code === code ? { ...template, ...patch } : template,
          ),
        }));
      },

      reset: () => {
        set({
          flights: FLIGHTS,
          orders: SERVICE_ORDERS,
          requests: FLIGHT_REQUESTS,
          templates: MESSAGE_TEMPLATES,
          nextFlightSeq: 1,
        });
      },
    }),
    { name: 'soc.prototype', version: 1 },
  ),
);

// ─────────────────────────── Производные выборки ───────────────────────────
//
// Селектор zustand сравнивает результат по ссылке. Возвращать из него
// `.map()` или `.filter()` нельзя: новый массив на каждом рендере вызывает
// бесконечную перерисовку. Поэтому селектор отдаёт исходный массив,
// а производные значения считаются в `useMemo`.

export function useFlightList(): FlightListItem[] {
  const flights = useSocStore((state) => state.flights);
  const orders = useSocStore((state) => state.orders);

  return useMemo(
    () =>
      flights.map((flight) => {
        const flightOrders = orders.filter((order) => order.flightId === flight.id);
        const margin = MARGINS.get(flight.id);
        return {
          id: flight.id,
          number: flight.number,
          clientId: flight.clientId,
          clientName: CLIENTS.find((client) => client.id === flight.clientId)?.name ?? '',
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
          unconfirmedServicesCount: flightOrders.filter(
            (order) => order.status === 'ordered' || order.status === 'draft',
          ).length,
          marginPercent: margin?.marginPercent ?? null,
          hasConflicts: flight.id === 'flt_025' || flight.id === 'flt_026',
          isDemo: flight.isDemo ?? false,
        };
      }),
    [flights, orders],
  );
}

export function useFlight(id: string | undefined): Flight | undefined {
  const flights = useSocStore((state) => state.flights);
  return useMemo(() => flights.find((flight) => flight.id === id), [flights, id]);
}

export function useFlightOrders(flightId: string | undefined): ServiceOrder[] {
  const orders = useSocStore((state) => state.orders);
  return useMemo(
    () => orders.filter((order) => order.flightId === flightId),
    [orders, flightId],
  );
}
