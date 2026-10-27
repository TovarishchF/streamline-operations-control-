import { useTranslation } from 'react-i18next';

/**
 * Наименование справочника на языке интерфейса (ADR-031).
 *
 * Аэропорты, услуги, типы ВС приходят с сервера объектом `{ ru, en }`:
 * это данные, а не строки интерфейса, и в `t()` им не место. Выбор
 * языка — здесь, а не `.name.ru` по месту: иначе английский интерфейс
 * показывает русские наименования.
 */
export function useLocalizedName(): (name: { ru: string; en: string } | null | undefined) => string {
  const { i18n } = useTranslation();
  const english = i18n.language.startsWith('en');
  return (name) => (name ? (english ? name.en || name.ru : name.ru) : '');
}
