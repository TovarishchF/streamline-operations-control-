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
