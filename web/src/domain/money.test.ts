import { describe, expect, it } from 'vitest';

import { formatAmount, moneyDifference } from './money';

describe('moneyDifference', () => {
  it('считает без потери копеек', () => {
    // 0.3 − 0.1 во float даёт 0.19999999999999998
    expect(moneyDifference({ amount: '0.30', currency: 'RUB' }, { amount: '0.10', currency: 'RUB' }))
      .toEqual({ amount: '0.2000', currency: 'RUB' });
  });

  it('сохраняет знак: поставщик просит меньше', () => {
    expect(moneyDifference({ amount: '70000.00', currency: 'USD' }, { amount: '75000.50', currency: 'USD' }))
      .toEqual({ amount: '-5000.5000', currency: 'USD' });
  });
});

describe('formatAmount', () => {
  it('округляет половину копейки вверх, как PDF и XLSX', () => {
    // 1.005 во float — 1.00499999999999989…, toLocaleString дал бы «1,00»
    expect(formatAmount('1.0050')).toEqual({ negative: false, digits: '1,01' });
    expect(formatAmount('855.5550')).toEqual({ negative: false, digits: '855,56' });
  });

  it('разбивает разряды неразрывным пробелом', () => {
    expect(formatAmount('1234567.8900').digits).toBe('1\u00a0234\u00a0567,89');
    expect(formatAmount('999.9950').digits).toBe('1\u00a0000,00');
  });

  it('отдаёт знак отдельно и не показывает «минус ноль»', () => {
    expect(formatAmount('-85.5550')).toEqual({ negative: true, digits: '85,56' });
    expect(formatAmount('-0.0010')).toEqual({ negative: false, digits: '0,00' });
  });
});
