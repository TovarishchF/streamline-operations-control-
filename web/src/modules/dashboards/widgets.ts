/**
 * Данные виджетов дашбордов `[ТЗ 3.6.2]`.
 *
 * Конверт `DashboardData` общий, а данные у каждого виджета свои: здесь
 * их схемы, по коду виджета. Виджет, который сервер не смог посчитать
 * (нет курса), приходит с `error` — он показывает объяснение, остальные
 * работают (`reports/services/dashboards.py`).
 */
import { z } from 'zod';

import { moneySchema } from '@/api/catalog';
import { flightStatusSchema } from '@/api/flights';
import type { DashboardData } from '@/api/reports';

const localizedSchema = z.object({ ru: z.string(), en: z.string() });

const orderItemSchema = z.object({
  orderId: z.string(),
  flightId: z.string(),
  flightNumber: z.string(),
  serviceName: localizedSchema,
  vendorName: z.string().nullable(),
  slaConfirmDeadline: z.string().nullable(),
});

const bucketsSchema = z.object({
  currency: z.string(),
  rateDate: z.string().optional(),
  items: z.array(z.object({ bucket: z.string(), amount: moneySchema })),
});

const totalsSchema = z.object({
  revenue: moneySchema,
  cost: moneySchema,
  margin: moneySchema,
  marginPercent: z.string().nullable(),
});

export const WIDGET_SCHEMAS = {
  // Диспетчер
  flights_today: z.object({ count: z.number().int(), from: z.string(), to: z.string() }),
  unconfirmed: z.object({
    count: z.number().int(),
    activeTotal: z.number().int(),
    dueSoon: z.number().int(),
  }),
  sla_breaches: z.object({ count: z.number().int(), items: z.array(orderItemSchema) }),
  aircraft_out_of_service: z.object({
    count: z.number().int(),
    items: z.array(
      z.object({
        id: z.string(),
        registration: z.string(),
        status: z.enum(['serviceable', 'maintenance', 'aog']),
        notes: z.string().nullable(),
      }),
    ),
  }),
  upcoming: z.object({
    total: z.number().int(),
    items: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        aircraftRegistration: z.string().nullable(),
        aircraftType: z.string().nullable(),
        depIcao: z.string(),
        arrIcao: z.string(),
        stdUtc: z.string(),
        staUtc: z.string(),
        status: flightStatusSchema,
      }),
    ),
  }),
  conflicts: z.object({
    count: z.number().int(),
    horizonDays: z.number().int(),
    items: z.array(
      z.object({
        kind: z.string(),
        flightId: z.string(),
        flightNumber: z.string(),
        message: z.string(),
        severity: z.enum(['blocking', 'warning']),
      }),
    ),
  }),
  flights_by_status: z.object({
    items: z.array(z.object({ status: flightStatusSchema, count: z.number().int() })),
  }),
  lead_time_overdue: z.object({
    count: z.number().int(),
    items: z.array(orderItemSchema.extend({ serviceAt: z.string() })),
  }),

  // Руководитель
  flights_count: z.object({
    total: z.number().int(),
    series: z.array(z.object({ weekStart: z.string(), count: z.number().int() })),
  }),
  margin_summary: totalsSchema.extend({
    currency: z.string(),
    series: z.array(totalsSchema.extend({ weekStart: z.string() })),
  }),
  margin_health: z.object({
    total: z.number().int(),
    belowThreshold: z.number().int(),
    negative: z.number().int(),
    thresholdPercent: z.string(),
  }),
  fleet_usage: z.object({ used: z.number().int(), total: z.number().int() }),
  category_margin: z.object({
    currency: z.string(),
    items: z.array(totalsSchema.extend({ category: z.string() })),
  }),
  top_clients: z.object({
    currency: z.string(),
    byRevenue: z.array(
      z.object({
        clientId: z.string(),
        name: z.string(),
        flights: z.number().int(),
        revenue: moneySchema,
        margin: moneySchema,
        marginPercent: z.string().nullable(),
      }),
    ),
    byMargin: z.array(
      z.object({
        clientId: z.string(),
        name: z.string(),
        flights: z.number().int(),
        revenue: moneySchema,
        margin: moneySchema,
        marginPercent: z.string().nullable(),
      }),
    ),
  }),
  top_vendors: z.object({
    currency: z.string(),
    items: z.array(
      z.object({
        vendorId: z.string(),
        name: z.string(),
        turnover: moneySchema,
        rating: z.string().nullable(),
        sufficientData: z.boolean(),
      }),
    ),
  }),
  receivables: bucketsSchema,
  payables: bucketsSchema,
} as const;

export type WidgetCode = keyof typeof WIDGET_SCHEMAS;
export type WidgetData<C extends WidgetCode> = z.infer<(typeof WIDGET_SCHEMAS)[C]>;

const widgetErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type WidgetResult<C extends WidgetCode> =
  | { kind: 'ok'; data: WidgetData<C> }
  | { kind: 'error'; message: string };

/** Данные виджета из конверта дашборда, проверенные его схемой. */
export function widgetResult<C extends WidgetCode>(
  dashboard: DashboardData,
  code: C,
): WidgetResult<C> {
  const widget = dashboard.widgets.find((item) => item.code === code);
  if (!widget) return { kind: 'error', message: code };
  const failed = widgetErrorSchema.safeParse(widget.data);
  if (failed.success) return { kind: 'error', message: failed.data.error.message };
  const parsed = WIDGET_SCHEMAS[code].safeParse(widget.data);
  if (!parsed.success) return { kind: 'error', message: parsed.error.message };
  return { kind: 'ok', data: parsed.data as WidgetData<C> };
}
