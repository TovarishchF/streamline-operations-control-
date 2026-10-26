/**
 * Статусные токены.
 *
 * Цвет несёт только смысл статуса. Токены задаются **один раз** здесь
 * и переиспользуются в Gantt, таблицах, пилюлях и мобильном приложении.
 * Один статус не может быть разного цвета на разных экранах — поэтому никакой
 * компонент не имеет права объявлять свой цвет для статуса.
 *
 * Названия токенов совпадают с полем `token` в `shared/state-machines/*.json`,
 * что позволяет красить любой статус, не зная его семантики.
 *
 * Значения — дизайн-система «Streamline Contrail» v3 (`docs/design/tokens.json`,
 * `status-<s>-fg|bg|line|dot`): подпись, заливка, контур и точка — точка
 * пилюли и передний край полосы на планшете. Подпись на своей заливке
 * не ниже 4.5:1, это проверяет `status-tokens.test.ts`.
 */

export const STATUS_TOKENS = {
  /** Создано, но работа не начата */
  neutral: { color: '#4a566c', background: '#eef1f6', border: '#d9dfe8', dot: '#8a96aa' },
  /** Идёт подготовка */
  progress: { color: '#0a4fb4', background: '#e6eefc', border: '#c2d5f6', dot: '#2f6fe0' },
  /** Готово к следующему шагу */
  ready: { color: '#0a6670', background: '#e0f4f5', border: '#b0dfe3', dot: '#12a1ad' },
  /** Выполняется прямо сейчас */
  active: { color: '#5a2fbf', background: '#f0eafd', border: '#d9cbf8', dot: '#7c4dff' },
  /** Успешно завершено */
  done: { color: '#156b3c', background: '#e4f4ea', border: '#b7e1c6', dot: '#22a35a' },
  /** Отменено пользователем */
  cancelled: { color: '#545e6e', background: '#f0f2f5', border: '#d8dde5', dot: '#a0a9b8' },
  /** Требует немедленного внимания: AOG, отказ поставщика, нарушение SLA */
  critical: { color: '#b0121c', background: '#fdeaeb', border: '#f5c0c3', dot: '#e5323b' },
  /** Предупреждение: низкая маржа, приближение дедлайна, истекающий контракт */
  warning: { color: '#8f4c05', background: '#fff1da', border: '#f3d29b', dot: '#e8940f' },
} as const;

export type StatusToken = keyof typeof STATUS_TOKENS;

/** Токен статуса рейса. Источник соответствия — `shared/state-machines/flight.json`. */
export const FLIGHT_STATUS_TOKENS: Record<string, StatusToken> = {
  planned: 'neutral',
  in_work: 'progress',
  ready_for_departure: 'ready',
  in_flight: 'active',
  arrived: 'active',
  completed: 'done',
  cancelled: 'cancelled',
  aog: 'critical',
};

/** Токен статуса заявки на услугу. */
export const SERVICE_ORDER_STATUS_TOKENS: Record<string, StatusToken> = {
  draft: 'neutral',
  ordered: 'progress',
  confirmed: 'ready',
  in_progress: 'active',
  completed: 'done',
  rejected: 'critical',
  cancelled: 'cancelled',
};

export function statusToken(
  status: string,
  map: Record<string, StatusToken>,
): (typeof STATUS_TOKENS)[StatusToken] {
  const token = map[status] ?? 'neutral';
  return STATUS_TOKENS[token];
}
