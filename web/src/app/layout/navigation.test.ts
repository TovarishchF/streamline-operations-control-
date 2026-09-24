/**
 * Состав рельса навигации.
 *
 * Дизайн-система задаёт девять пунктов в трёх группах (карточка `NavRail`).
 * Проверка стоит здесь, потому что разрастание навигации происходит
 * незаметно: каждый новый экран просит себе строку, и через полгода рельс
 * снова становится списком из тридцати пунктов.
 *
 * Отдельно проверяется, что сокращение рельса ничего не спрятало: каждый
 * экран раздела достижим либо самим пунктом, либо его вкладкой.
 */
import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, NAV_PATHS } from './navigation';

describe('рельс навигации', () => {
  it('три группы', () => {
    expect(NAV_GROUPS.map((group) => group.key)).toEqual(['operations', 'finance', 'system']);
  });

  it('девять пунктов', () => {
    const items = NAV_GROUPS.flatMap((group) => group.items);
    expect(items).toHaveLength(9);
  });

  it('у каждого пункта есть значок и адрес', () => {
    for (const item of NAV_GROUPS.flatMap((group) => group.items)) {
      expect(item.icon, `пункт ${item.key}`).not.toBe('');
      expect(item.path.startsWith('/'), `пункт ${item.key}`).toBe(true);
    }
  });

  it('пункт ведёт на первый экран своего раздела', () => {
    for (const item of NAV_GROUPS.flatMap((group) => group.items)) {
      if (!item.children) continue;
      expect(item.children[0]?.path, `пункт ${item.key}`).toBe(item.path);
    }
  });

  it('ключи пунктов не повторяются', () => {
    const keys = NAV_GROUPS.flatMap((group) => group.items).map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('адреса вкладок попадают в перечень путей', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        for (const child of item.children ?? []) {
          expect(NAV_PATHS, `вкладка ${child.key}`).toContain(child.path);
        }
      }
    }
  });
});
