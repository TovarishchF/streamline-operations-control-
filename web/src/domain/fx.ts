/**
 * Динамика курсов для биржевого графика `[ТЗ 3.4.1]`.
 *
 * Курс ЦБ — одно значение в день: сколько рублей стоит единица валюты
 * (ADR-004). Биржевой вид строится из этого ряда: дневная свеча открывается
 * закрытием прошлого дня, недельная — закрытием прошлой недели; максимум
 * и минимум — крайние курсы внутри свечи.
 *
 * Арифметика — на Decimal (`CLAUDE.md § 3` п. 1): разница курсов идёт в
 * подписи и проценты, а `float` портит четвёртый знак. Числа графику
 * отдаются только как координаты точек.
 */
import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** Курс на дату: `YYYY-MM-DD` и десятичная строка из API. */
export interface RatePoint {
  date: string;
  rate: string;
}

/** Свеча: дата начала, курсы открытия, закрытия, минимум и максимум. */
export interface Candle {
  date: string;
  open: string;
  close: string;
  low: string;
  high: string;
}

export type Direction = 'up' | 'down' | 'flat';

export interface Change {
  /** Разница курсов, 4 знака: `0.5123`, `-1.0040`. */
  abs: string;
  /** Изменение в процентах, 2 знака. `null` — база нулевая, процент не определён. */
  pct: string | null;
  direction: Direction;
}

export interface PeriodStats {
  open: string;
  close: string;
  low: string;
  high: string;
  change: Change;
}

const RATE_DIGITS = 4;

export function change(from: string, to: string): Change {
  const start = new D(from);
  const diff = new D(to).minus(start);
  const direction: Direction = diff.isZero() ? 'flat' : diff.isPositive() ? 'up' : 'down';
  return {
    abs: diff.toFixed(RATE_DIGITS),
    pct: start.isZero() ? null : diff.dividedBy(start).times(100).toFixed(2),
    direction,
  };
}

function extremes(values: string[]): { low: string; high: string } {
  const decimals = values.map((value) => new D(value));
  return {
    low: D.min(...decimals).toFixed(RATE_DIGITS),
    high: D.max(...decimals).toFixed(RATE_DIGITS),
  };
}

/** Дневные свечи: открытие — закрытие предыдущего дня ряда. */
export function dailyCandles(points: RatePoint[]): Candle[] {
  return points.map((point, index) => {
    const open = points[index - 1]?.rate ?? point.rate;
    return {
      date: point.date,
      open: new D(open).toFixed(RATE_DIGITS),
      close: new D(point.rate).toFixed(RATE_DIGITS),
      ...extremes([open, point.rate]),
    };
  });
}

/** Понедельник недели, в которую попадает дата (UTC). */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const shift = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - shift);
  return day.toISOString().slice(0, 10);
}

/** Недельные свечи: открытие — последний курс прошлой недели. */
export function weeklyCandles(points: RatePoint[]): Candle[] {
  const weeks = new Map<string, RatePoint[]>();
  for (const point of points) {
    const key = weekStart(point.date);
    weeks.set(key, [...(weeks.get(key) ?? []), point]);
  }

  const candles: Candle[] = [];
  let previousClose: string | null = null;
  for (const [date, week] of weeks) {
    const first = week[0];
    const last = week[week.length - 1];
    if (!first || !last) continue;
    const open = previousClose ?? first.rate;
    candles.push({
      date,
      open: new D(open).toFixed(RATE_DIGITS),
      close: new D(last.rate).toFixed(RATE_DIGITS),
      ...extremes([open, ...week.map((point) => point.rate)]),
    });
    previousClose = last.rate;
  }
  return candles;
}

/** Открытие, закрытие, крайние курсы и изменение за период. */
export function periodStats(points: RatePoint[]): PeriodStats | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  return {
    open: new D(first.rate).toFixed(RATE_DIGITS),
    close: new D(last.rate).toFixed(RATE_DIGITS),
    ...extremes(points.map((point) => point.rate)),
    change: change(first.rate, last.rate),
  };
}
