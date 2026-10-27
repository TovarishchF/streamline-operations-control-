/**
 * Автоматы рейса и заявки на XState из единого определения (ADR-015,
 * `CLAUDE.md § 6`).
 *
 * `shared/state-machines/*.json` читают обе стороны: сервер исполняет по
 * нему переходы (`django-fsm-2`), клиент строит из него машину. Своих
 * описаний переходов у клиента нет — расхождение сторон исключено
 * построением.
 *
 * Условия переходов клиент не проверяет: доступные и заблокированные
 * переходы с перечнем причин присылает сервер (`SPEC.md § 4.4`). Машина
 * отвечает на вопрос «куда ведёт переход» и «бывает ли он из этого
 * состояния» — им пользуется панель статуса.
 */
import { createMachine, transition as step, type AnyStateMachine } from 'xstate';

import flightDefinition from '@shared/state-machines/flight.json';
import orderDefinition from '@shared/state-machines/service-order.json';

export interface MachineDefinition {
  id: string;
  initial: string;
  states: Record<string, { final?: boolean }>;
  transitions: { name: string; from: string[]; to: string }[];
}

export function machineFrom(definition: MachineDefinition): AnyStateMachine {
  const states: Record<string, { on: Record<string, string>; type?: 'final' }> = {};
  for (const [name, state] of Object.entries(definition.states)) {
    states[name] = state.final ? { on: {}, type: 'final' } : { on: {} };
  }
  for (const transition of definition.transitions) {
    for (const source of transition.from) {
      const state = states[source];
      if (!state) throw new Error(`переход ${transition.name}: нет состояния ${source}`);
      state.on[transition.name] = transition.to;
    }
  }
  return createMachine({ id: definition.id, initial: definition.initial, states });
}

export const flightMachine = machineFrom(flightDefinition as MachineDefinition);
export const serviceOrderMachine = machineFrom(orderDefinition as MachineDefinition);

/** Состояние, в которое переход ведёт из данного; `null` — из него такого перехода нет. */
export function targetOf(machine: AnyStateMachine, from: string, transition: string): string | null {
  const snapshot = machine.resolveState({ value: from, context: undefined });
  if (!snapshot.can({ type: transition })) return null;
  const [next] = step(machine, snapshot, { type: transition });
  return typeof next.value === 'string' ? next.value : null;
}
