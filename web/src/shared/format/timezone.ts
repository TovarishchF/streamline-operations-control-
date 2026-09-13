/**
 * Работа с часовыми зонами `[ТЗ 3.1.1]`.
 *
 * Смещение считается от зоны IANA средствами платформы, а не по таблице
 * в коде: таблица устаревает молча. Астраханская область перешла на UTC+4
 * в 2016 году, и набор OpenFlights до сих пор об этом не знает — ровно тот
 * случай, ради которого справочник выверяется отдельно.
 *
 * Момент времени передаётся снаружи: смещение зависит от даты (переход
 * на летнее время), а обращаться к часам браузера в коде нельзя —
 * только `useClock()` (`CLAUDE.md § 3` п. 2).
 */

/** Смещение зоны от UTC в часах на заданный момент. */
export function utcOffsetHours(timeZone: string, at: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    const name = formatter.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
    if (!name) return 0;

    // Формат: GMT, GMT+3, GMT+03:00, GMT-03:30
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return 0;

    const [, sign, hours, minutes] = match;
    const value = Number(hours) + Number(minutes ?? 0) / 60;
    return sign === '-' ? -value : value;
  } catch {
    // Неизвестная зона: показать ноль честнее, чем уронить экран.
    return 0;
  }
}

/** Подпись смещения: `UTC+3`, `UTC-3:30`, `UTC` (`CLAUDE.md § 10`). */
export function formatUtcOffset(timeZone: string, at: Date): string {
  const offset = utcOffsetHours(timeZone, at);
  if (offset === 0) return 'UTC';

  const sign = offset > 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute);
  const minutes = Math.round((absolute - hours) * 60);
  return minutes === 0
    ? `UTC${sign}${String(hours)}`
    : `UTC${sign}${String(hours)}:${String(minutes).padStart(2, '0')}`;
}
