/**
 * Ни одной русской строки в компонентах — всё через `t()` (`TASKS.md` M10,
 * ТЗ 4.5). Английский интерфейс с русскими вкраплениями — дефект, а не мелочь.
 *
 * Проверяются экраны, оболочка приложения и общие элементы интерфейса.
 * Комментарии на русском — норма проекта, поэтому они вырезаются до проверки.
 * Наименования справочников приходят с сервера объектом `{ ru, en }`
 * (ADR-031) и в исходниках не встречаются.
 */
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob<string>(
  ['/src/modules/**/*.tsx', '/src/app/**/*.tsx', '/src/shared/ui/**/*.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

const CYRILLIC = /[А-Яа-яЁё]/;

/** Код без комментариев: строки и шаблоны остаются, `//` и `/* *\/` — нет. */
function withoutComments(source: string): string {
  let result = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote) {
      result += char;
      if (char === '\\') {
        result += source[index + 1] ?? '';
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end - 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    result += char;
  }
  return result;
}

describe('строки интерфейса', () => {
  it('находит исходники', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it('отличает строку от комментария', () => {
    expect(CYRILLIC.test(withoutComments("const a = 'Привет'; // ok"))).toBe(true);
    expect(CYRILLIC.test(withoutComments('const url = "http://x"; // Комментарий'))).toBe(false);
    expect(CYRILLIC.test(withoutComments('/* Блок */ const b = 1;'))).toBe(false);
    expect(CYRILLIC.test(withoutComments('<span>{/* Подпись */}Текст</span>'))).toBe(true);
  });

  it('в компонентах нет русского текста вне t()', () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, source]) =>
      withoutComments(source)
        .split('\n')
        .filter((line) => CYRILLIC.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
