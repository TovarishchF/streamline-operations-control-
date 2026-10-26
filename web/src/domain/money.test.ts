import { describe, expect, it } from 'vitest';

import { moneyDifference } from './money';

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
