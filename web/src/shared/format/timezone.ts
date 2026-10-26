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

/**
 * Местное время зоны: `11:13`. Подпись зоны ставит вызывающий:
 * время без зоны в интерфейсе не выводится.
 */
export function formatLocalTime(timeZone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(at);
  } catch {
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Зоны России. Их время называют от Москвы: `MSK+0`, `MSK+4`, `MSK-1`.
 * Список отвечает только за то, какие зоны подписывать от Москвы; само
 * смещение считает платформа, поэтому смена правил зоны его не устарит.
 */
const MOSCOW_RELATIVE_ZONES = new Set([
  'Europe/Kaliningrad',
  'Europe/Moscow', 'Europe/Kirov', 'Europe/Volgograd',
  'Europe/Astrakhan', 'Europe/Samara', 'Europe/Saratov', 'Europe/Ulyanovsk',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Barnaul', 'Asia/Krasnoyarsk', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Tomsk',
  'Asia/Irkutsk',
  'Asia/Chita', 'Asia/Khandyga', 'Asia/Yakutsk',
  'Asia/Ust-Nera', 'Asia/Vladivostok',
  'Asia/Magadan', 'Asia/Sakhalin', 'Asia/Srednekolymsk',
  'Asia/Anadyr', 'Asia/Kamchatka',
]);

/**
 * Короткое имя зоны для шапки: `MSK+0` для Москвы, `MSK+2` для
 * Екатеринбурга, `UTC+5` там, где у зоны нет общепринятого сокращения.
 */
export function zoneAbbreviation(timeZone: string, at: Date): string {
  // Платформа называет Москву «GMT+3»; диспетчеры говорят MSK, а остальные
  // зоны России — смещением от неё.
  if (MOSCOW_RELATIVE_ZONES.has(timeZone)) {
    const shift = utcOffsetHours(timeZone, at) - utcOffsetHours('Europe/Moscow', at);
    return `MSK${shift < 0 ? '-' : '+'}${String(Math.abs(shift))}`;
  }
  try {
    const name = new Intl.DateTimeFormat('ru-RU', { timeZone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (name && !name.startsWith('GMT') && !name.startsWith('UTC')) return name;
  } catch {
    // Неизвестная зона — подпись смещением ниже.
  }
  return formatUtcOffset(timeZone, at);
}
