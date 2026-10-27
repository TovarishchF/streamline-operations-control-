import { describe, expect, it } from 'vitest';

import flightDefinition from '@shared/state-machines/flight.json';
import orderDefinition from '@shared/state-machines/service-order.json';

import { flightMachine, serviceOrderMachine, targetOf, type MachineDefinition } from './machines';

/**
 * Машины на клиенте повторяют определение из JSON переход в переход
 * (ADR-015): из каждого состояния доступны ровно объявленные переходы
 * и ведут туда же, куда их ведёт сервер.
 */
describe.each([
  ['рейс', flightMachine, flightDefinition as MachineDefinition],
  ['заявка', serviceOrderMachine, orderDefinition as MachineDefinition],
])('автомат «%s»', (_, machine, definition) => {
  it('каждый переход из определения ведёт в объявленное состояние', () => {
    for (const transition of definition.transitions) {
      for (const source of transition.from) {
        expect(targetOf(machine, source, transition.name), `${source} → ${transition.name}`).toBe(
          transition.to,
        );
      }
    }
  });

  it('необъявленный переход недоступен', () => {
    for (const state of Object.keys(definition.states)) {
      for (const transition of definition.transitions) {
        if (transition.from.includes(state)) continue;
        expect(targetOf(machine, state, transition.name), `${state} → ${transition.name}`).toBeNull();
      }
    }
  });
});

describe('автомат рейса', () => {
  it('из завершённого и отменённого переходов нет', () => {
    expect(targetOf(flightMachine, 'completed', 'cancel')).toBeNull();
    expect(targetOf(flightMachine, 'cancelled', 'start')).toBeNull();
  });
});
