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
 */

export const STATUS_TOKENS = {
  /** Создано, но работа не начата */
  neutral: { color: '#8c8c8c', background: '#fafafa', border: '#d9d9d9' },
  /** Идёт подготовка */
  progress: { color: '#1677ff', background: '#e6f4ff', border: '#91caff' },
  /** Готово к следующему шагу */
  ready: { color: '#52c41a', background: '#f6ffed', border: '#b7eb8f' },
  /** Выполняется прямо сейчас */
  active: { color: '#722ed1', background: '#f9f0ff', border: '#d3adf7' },
  /** Успешно завершено */
  done: { color: '#389e0d', background: '#f6ffed', border: '#b7eb8f' },
  /** Отменено пользователем */
  cancelled: { color: '#595959', background: '#f5f5f5', border: '#d9d9d9' },
  /** Требует немедленного внимания: AOG, отказ поставщика, нарушение SLA */
  critical: { color: '#cf1322', background: '#fff1f0', border: '#ffa39e' },
  /** Предупреждение: низкая маржа, приближение дедлайна, истекающий контракт */
  warning: { color: '#d46b08', background: '#fff7e6', border: '#ffd591' },
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
