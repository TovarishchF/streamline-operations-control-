/**
 * Локализация интерфейса.
 *
 * ТЗ 4.5: полный русский и английский. Проверка — ни одной захардкоженной
 * русской строки в компонентах, всё через `t()` (`TASKS.md` M10).
 *
 * Наименования справочников (аэропорты, услуги, статусы) сюда НЕ попадают:
 * это данные, редактируемые администратором, они хранятся полями `name_ru`
 * и `name_en` и приходят с сервера объектом `{ ru, en }` (ADR-031).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import ru from './locales/ru.json';
import en from './locales/en.json';

export const SUPPORTED_LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ru: { translation: ru },
      en: { translation: en },
    },
    fallbackLng: 'ru',
    supportedLngs: SUPPORTED_LOCALES,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'soc.locale',
      caches: ['localStorage'],
    },
  });

export default i18n;
