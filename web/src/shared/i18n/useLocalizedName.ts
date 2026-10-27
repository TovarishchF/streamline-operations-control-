import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import i18n from './index';

type Localized = { ru: string; en: string } | null | undefined;

function pick(name: Localized, english: boolean): string {
  return name ? (english ? name.en || name.ru : name.ru) : '';
}

/**
 * Наименование справочника на языке интерфейса (ADR-031).
 *
 * Аэропорты, услуги, типы ВС приходят с сервера объектом `{ ru, en }`:
 * это данные, а не строки интерфейса, и в `t()` им не место. Выбор
 * языка — здесь, а не `.name.ru` по месту: иначе английский интерфейс
 * показывает русские наименования.
 */
export function useLocalizedName(): (name: Localized) => string {
  const { i18n: instance } = useTranslation();
  const english = instance.language.startsWith('en');
  // Ссылка меняется только со сменой языка: функция стоит в зависимостях
  // хуков, а часы перерисовывают экран каждую секунду. Новая функция
  // на каждом тике пересобирала планшет суточного плана и сбрасывала
  // свёрнутые строки, выделение и прокрутку.
  return useCallback((name: Localized) => pick(name, english), [english]);
}

/**
 * То же без хука — для подписей внутри колбэков. Компонент, который
 * её вызывает, переводит интерфейс через `useTranslation` и потому
 * перерисовывается при смене языка.
 */
export function localizedName(name: Localized): string {
  return pick(name, i18n.language.startsWith('en'));
}
