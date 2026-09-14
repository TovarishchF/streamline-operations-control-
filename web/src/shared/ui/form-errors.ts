/**
 * Ошибки сервера в поля формы.
 *
 * Сервер возвращает `{ error: { code, message, details } }`, где `details` —
 * словарь «поле → список сообщений» (`BACKEND.md § 9`). Показывать это
 * общим красным баннером значит заставлять человека искать глазами, что
 * именно не так: сообщение обязано стоять под тем полем, к которому
 * относится.
 *
 * Поля, которых в форме нет, не теряются — они уходят в общий текст,
 * иначе отказ по причине, не имеющей поля, выглядел бы как молчание.
 */
import type { FormInstance } from 'antd';

import { ApiError } from '@/api/client';

/** Текст для баннера: то, что не легло ни на одно поле. `null` — баннер не нужен. */
export function applyApiError(
  error: unknown,
  form: FormInstance<never>,
  fallback: string,
): string | null {
  if (!(error instanceof ApiError)) {
    return fallback;
  }

  const known = new Set(
    form
      .getFieldsError()
      .map((entry) => entry.name)
      .filter((name): name is string[] => Array.isArray(name))
      .map((name) => name.join('.')),
  );

  const fields: { name: string[]; errors: string[] }[] = [];
  const orphans: string[] = [];

  for (const [field, value] of Object.entries(error.details)) {
    const messages = (Array.isArray(value) ? value : [value]).map(String);
    if (known.has(field)) {
      fields.push({ name: [field], errors: messages });
    } else {
      orphans.push(...messages);
    }
  }

  if (fields.length > 0) {
    form.setFields(fields as never);
  }

  // Если всё легло на поля, баннер не нужен: сообщения уже на экране.
  if (fields.length > 0 && orphans.length === 0) {
    return null;
  }
  return orphans.length > 0 ? orphans.join(' ') : error.message;
}
