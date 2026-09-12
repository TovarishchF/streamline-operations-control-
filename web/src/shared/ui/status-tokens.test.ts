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
