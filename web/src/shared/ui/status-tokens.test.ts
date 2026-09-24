/**
 * Согласованность статусных токенов с определениями автоматов.
 *
 * `CLAUDE.md § 10`: один статус не может быть разного цвета на разных экранах.
 * Здесь проверяется более сильное свойство — что у каждого состояния автомата
 * вообще есть цвет, и что лишних состояний в карте нет. Иначе новое состояние
 * (как `arrived` из ADR-009) молча получит серый цвет «по умолчанию».
 */
import { describe, expect, it } from 'vitest';

import flightMachine from '@shared/state-machines/flight.json';
import serviceOrderMachine from '@shared/state-machines/service-order.json';
import {
  FLIGHT_STATUS_TOKENS,
  SERVICE_ORDER_STATUS_TOKENS,
  STATUS_TOKENS,
  statusToken,
} from './status-tokens';

describe('статусные токены', () => {
  it('каждое состояние рейса имеет цвет', () => {
    const states = Object.keys(flightMachine.states);
    const mapped = Object.keys(FLIGHT_STATUS_TOKENS);
    expect(mapped.sort()).toEqual(states.sort());
  });

  it('каждое состояние заявки имеет цвет', () => {
    const states = Object.keys(serviceOrderMachine.states);
    const mapped = Object.keys(SERVICE_ORDER_STATUS_TOKENS);
    expect(mapped.sort()).toEqual(states.sort());
  });

  it('токен из автомата совпадает с токеном в карте цветов', () => {
    for (const [state, definition] of Object.entries(flightMachine.states)) {
      expect(FLIGHT_STATUS_TOKENS[state], `состояние ${state}`).toBe(definition.token);
    }
  });

  it('все используемые токены объявлены', () => {
    const used = [
      ...Object.values(FLIGHT_STATUS_TOKENS),
      ...Object.values(SERVICE_ORDER_STATUS_TOKENS),
    ];
    for (const token of used) {
      expect(STATUS_TOKENS).toHaveProperty(token);
    }
  });

  it('неизвестный статус не роняет интерфейс, а красится нейтрально', () => {
    expect(statusToken('нет_такого', FLIGHT_STATUS_TOKENS)).toBe(STATUS_TOKENS.neutral);
  });
});

/** Относительная яркость по WCAG 2.1, формула 1.4.3. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Контраст статусной пары.
 *
 * В прежней палитре готовность давала 2.2:1, завершение 3.4:1: подпись
 * тонула в своей же заливке, а статус — единственное, что диспетчер читает
 * боковым зрением. Проверка стоит здесь, чтобы подобранная пара не
 * испортилась незаметно при следующей правке цвета.
 */
describe('контраст статусной пары', () => {
  it('подпись читается на своей заливке не хуже 4.5:1', () => {
    for (const [name, token] of Object.entries(STATUS_TOKENS)) {
      expect(contrast(token.color, token.background), `токен ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('рамка отличима от заливки', () => {
    for (const [name, token] of Object.entries(STATUS_TOKENS)) {
      expect(contrast(token.border, token.background), `токен ${name}`).toBeGreaterThan(1.05);
    }
  });
});
