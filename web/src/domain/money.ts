/**
 * Денежная арифметика на клиенте.
 *
 * Суммы приходят десятичной строкой и считаются на Decimal (`CLAUDE.md § 3`
 * п. 1): `float` теряет копейки уже на сложении. Считается здесь, а не
 * в разметке экрана (п. 16).
 */
import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * Разница двух сумм в одной валюте, четыре знака, как хранит сервер.
 * Положительная — уменьшаемое больше.
 */
export function moneyDifference<M extends { amount: string }>(minuend: M, subtrahend: M): M {
  return { ...minuend, amount: new D(minuend.amount).minus(subtrahend.amount).toFixed(4) };
}

/**
 * Сумма для показа: два знака с округлением `ROUND_HALF_UP`, как в PDF
 * и XLSX, разряды через неразрывный пробел, запятая перед копейками.
 * Через `float` половина копейки округлялась бы иначе: 1,0050 → 1,00.
 * Знак отдаётся отдельно — экран рисует его своим символом и цветом.
 */
export function formatAmount(amount: string): { negative: boolean; digits: string } {
  const rounded = new D(amount).toDecimalPlaces(2);
  const [whole = '0', cents = '00'] = rounded.abs().toFixed(2).split('.');
  return {
    negative: rounded.lessThan(0),
    digits: `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${cents}`,
  };
}
