import { describe, expect, it } from 'vitest';

import { change, dailyCandles, periodStats, weekStart, weeklyCandles } from './fx';

const POINTS = [
  { date: '2026-10-19', rate: '81.1000' }, // понедельник
  { date: '2026-10-20', rate: '81.5000' },
  { date: '2026-10-21', rate: '80.9000' },
  { date: '2026-10-24', rate: '81.2000' }, // суббота той же недели
  { date: '2026-10-27', rate: '82.0000' }, // вторник следующей
];

describe('change', () => {
  it('считает разницу и процент на Decimal с округлением половины вверх', () => {
    expect(change('80.0000', '80.5123')).toEqual({ abs: '0.5123', pct: '0.64', direction: 'up' });
    expect(change('81.2000', '80.0000')).toEqual({ abs: '-1.2000', pct: '-1.48', direction: 'down' });
    expect(change('81.2000', '81.2000')).toEqual({ abs: '0.0000', pct: '0.00', direction: 'flat' });
  });

  it('не делит на ноль', () => {
    expect(change('0', '1').pct).toBeNull();
  });
});

describe('dailyCandles', () => {
  it('открывает день закрытием предыдущего', () => {
    const candles = dailyCandles(POINTS);
    expect(candles[0]).toEqual({
      date: '2026-10-19', open: '81.1000', close: '81.1000', low: '81.1000', high: '81.1000',
    });
    expect(candles[2]).toEqual({
      date: '2026-10-21', open: '81.5000', close: '80.9000', low: '80.9000', high: '81.5000',
    });
  });
});

describe('weeklyCandles', () => {
  it('группирует по неделям с понедельника', () => {
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // воскресенье
    expect(weekStart('2026-10-26')).toBe('2026-10-26'); // понедельник
  });

  it('открывает неделю закрытием прошлой, крайние курсы — по всем дням', () => {
    expect(weeklyCandles(POINTS)).toEqual([
      { date: '2026-10-19', open: '81.1000', close: '81.2000', low: '80.9000', high: '81.5000' },
      { date: '2026-10-26', open: '81.2000', close: '82.0000', low: '81.2000', high: '82.0000' },
    ]);
  });
});

describe('periodStats', () => {
  it('сводит период', () => {
    expect(periodStats(POINTS)).toEqual({
      open: '81.1000',
      close: '82.0000',
      low: '80.9000',
      high: '82.0000',
      change: { abs: '0.9000', pct: '1.11', direction: 'up' },
    });
  });

  it('пустой ряд — нет сводки', () => {
    expect(periodStats([])).toBeNull();
  });
});
