/**
 * Статусные токены.
 *
 * `CLAUDE.md § 10`: цвет несёт только смысл статуса. Токены задаются **один раз**
 * здесь и переиспользуются в Gantt, таблицах, тегах и мобильном приложении.
 * Один статус не может быть разного цвета на разных экранах — поэтому никакой
 * компонент не имеет права объявлять свой цвет для статуса.
 *
 * Названия токенов совпадают с полем `token` в `shared/state-machines/*.json`,
 * что позволяет красить любой статус, не зная его семантики.
 *
 * Пары перебраны в «Основе 2.0» под контраст текста на своей заливке
 * не ниже 4.5:1: в прежней палитре готовность давала 2.2:1, завершение
 * 3.4:1, предупреждение 3.3:1 — на плотной таблице это не читается.
 * Смысл цвета не менялся, восемь смыслов остались теми же.
 */

export const STATUS_TOKENS = {
  /** Создано, но работа не начата */
  neutral: { color: '#5b6779', background: '#f2f5f8', border: '#dde3ea' },
  /** Идёт подготовка */
  progress: { color: '#0f5fd1', background: '#eaf2ff', border: '#bcd6ff' },
  /** Готово к следующему шагу */
  ready: { color: '#0d6e7a', background: '#e6f6f8', border: '#b3e0e6' },
  /** Выполняется прямо сейчас */
  active: { color: '#6b34c9', background: '#f2ecfd', border: '#dccbf8' },
  /** Успешно завершено */
  done: { color: '#1d7a45', background: '#eaf7ef', border: '#bbe5c9' },
  /** Отменено пользователем */
  cancelled: { color: '#4e5867', background: '#f1f3f6', border: '#d8dee6' },
  /** Требует немедленного внимания: AOG, отказ поставщика, нарушение SLA */
  critical: { color: '#c1121f', background: '#fdecec', border: '#f6c2c2' },
  /** Предупреждение: низкая маржа, приближение дедлайна, истекающий контракт */
  warning: { color: '#a85a05', background: '#fff4e2', border: '#f6d9a8' },
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
