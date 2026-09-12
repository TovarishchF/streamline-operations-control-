/**
 * Полнота локализации.
 *
 * ТЗ 4.5 требует полный русский и английский. Недостающий ключ в одном языке —
 * это не «мелочь на потом», а английский интерфейс с русскими вкраплениями
 * на экране у заказчика.
 */
import { describe, expect, it } from 'vitest';

import ru from './locales/ru.json';
import en from './locales/en.json';

type Tree = Record<string, unknown>;

function flatten(source: Tree, prefix = ''): string[] {
  return Object.entries(source).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? flatten(value as Tree, path)
      : [path];
  });
}

const ruKeys = flatten(ru as Tree);
const enKeys = flatten(en as Tree);

describe('локализация', () => {
  it('английский покрывает все русские ключи', () => {
    const missing = ruKeys.filter((key) => !enKeys.includes(key));
    expect(missing, `нет английского перевода: ${missing.join(', ')}`).toEqual([]);
  });

  it('русский покрывает все английские ключи', () => {
    const missing = enKeys.filter((key) => !ruKeys.includes(key));
    expect(missing, `нет русского перевода: ${missing.join(', ')}`).toEqual([]);
  });

  it('нет пустых значений', () => {
    const empty = flatten(ru as Tree).filter((key) => {
      const value = key.split('.').reduce<unknown>(
        (node, part) => (node as Tree | undefined)?.[part],
        ru,
      );
      return typeof value === 'string' && value.trim() === '';
    });
    expect(empty).toEqual([]);
  });

  it('коды ошибок контракта имеют перевод в обоих языках', () => {
    // Коды из перечисления ErrorCode в openapi.yaml, которые видит пользователь.
    const userFacingCodes = [
      'VALIDATION_ERROR',
      'PERMISSION_DENIED',
      'NOT_FOUND',
      'TRANSITION_NOT_ALLOWED',
      'GUARD_NOT_SATISFIED',
      'CONTRACT_EXPIRED',
      'PRICE_NOT_FOUND',
      'CURRENCY_MISMATCH',
      'DOCUMENT_IMMUTABLE',
      'INTEGRATION_UNAVAILABLE',
      'DEMO_ONLY_OPERATION',
      'INTERNAL_ERROR',
    ];
    for (const code of userFacingCodes) {
      expect(ruKeys, `нет русского текста для ${code}`).toContain(`errors.${code}`);
      expect(enKeys, `нет английского текста для ${code}`).toContain(`errors.${code}`);
    }
  });
});
