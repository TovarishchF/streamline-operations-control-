import type { ThemeConfig } from 'antd';

/**
 * Тема Ant Design (`CLAUDE.md § 10`).
 *
 * Аудитория — диспетчеры, которые смотрят в экран по 12 часов, и финансисты,
 * которым нужна плотная таблица. Приоритет — плотность информации
 * и однозначность статусов, а не декоративность.
 *
 * Самописного CSS-фреймворка нет: база — тема через ConfigProvider.
 * Тёмная тема не требуется и не поддерживается.
 *
 * Значения — из дизайн-системы «Streamline SOC», версия 2. Имена токенов
 * совпадают с `tokens.json` системы: цвет статуса здесь и цвет статуса там
 * обязаны сходиться, иначе система перестаёт быть источником правды.
 */

/**
 * Цвета обвязки, поверхностей и текста.
 *
 * Объявлены здесь, а не в компонентах: цвет, заданный в JSX, невозможно
 * поменять во всей системе одним движением. Смыслы статусов живут отдельно —
 * `shared/ui/status-tokens.ts`; ни один компонент не вправе объявить
 * собственный цвет для статуса.
 */
export const SOC_COLORS = {
  // ── Обвязка ───────────────────────────────────────────────────────────
  /** Тёмно-синий фон обвязки: полоса шапки, шапка портала, бланк документа.
   *  Внутри таблицы, формы и карточки его нет — там контраст отдан данным. */
  brandInk: '#0d2b4e',
  brandInkRaised: '#173f6b',
  brandInkLine: 'rgba(255, 255, 255, 0.16)',
  onBrandInk: '#ffffff',
  onBrandInkMuted: 'rgba(255, 255, 255, 0.72)',
  /** Красный знака. Живёт только внутри знака: в интерфейсе красный занят
   *  критическим статусом. */
  brandMarkRed: '#bf131b',

  // ── Действие ──────────────────────────────────────────────────────────
  brand: '#0f5fd1',
  brandHover: '#0a4aa6',
  brand100: '#eaf2ff',
  brand200: '#bcd6ff',

  // ── Поверхности ───────────────────────────────────────────────────────
  surfacePage: '#f2f5f8',
  surface: '#ffffff',
  /** Шапка таблицы, итоговая строка, неактивная вкладка. */
  surfaceSunken: '#f7f9fb',
  /** Волосяная линия внутри карточки. */
  surfaceLine: '#edf1f5',

  // ── Границы ───────────────────────────────────────────────────────────
  /** Край карточки и таблицы. */
  border: '#dde3ea',
  /** Контур нажимаемого: поле ввода и кнопка обязаны иметь 3:1,
   *  иначе их не видно на `surface-page`. */
  borderControl: '#7f8ea2',
  borderStrong: '#c3ccd6',

  // ── Текст ─────────────────────────────────────────────────────────────
  ink: '#101828',
  inkSecondary: '#566173',
  inkTertiary: '#6b7687',
  /** Только там, где значок ничего не сообщает: разделитель крошек,
   *  стрелка между аэропортами. */
  inkQuiet: '#97a2b2',
  inkDisabled: '#aab4c2',

  // ── Фокус ─────────────────────────────────────────────────────────────
  focusRing: '#0f5fd1',
  /** На тёмной обвязке синее кольцо не видно. */
  focusRingOnInk: '#7fb0ff',

  // ── Подсветка строк ───────────────────────────────────────────────────
  /** Больше подсветок не вводится. */
  rowCritical: '#fdeded',
  rowCurrent: '#eef4ff',
  rowSeed: '#f6f1fe',
} as const;

/** Радиусы. Полоса Gantt — 3, нажимаемое — 6, карточка — 10, тег — пилюля. */
export const SOC_RADIUS = { bar: 3, control: 6, panel: 10, pill: 999 } as const;

/** Плотность. Мишень 32 px: диспетчер работает мышью двенадцать часов. */
export const SOC_DENSITY = {
  rowPaddingY: 5,
  cellPaddingX: 8,
  controlHeight: 32,
  controlHeightSm: 28,
  formItemGap: 12,
  cardPadding: 12,
  contentPadding: 16,
  chromeHeight: 52,
  railWidth: 216,
} as const;

export const SANS_STACK =
  '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const MONO_STACK = "'JetBrains Mono', 'Consolas', monospace";

export const socTheme: ThemeConfig = {
  token: {
    colorPrimary: SOC_COLORS.brand,
    colorPrimaryHover: SOC_COLORS.brandHover,
    colorLink: SOC_COLORS.brand,
    colorLinkHover: SOC_COLORS.brandHover,

    colorBgLayout: SOC_COLORS.surfacePage,
    colorBgContainer: SOC_COLORS.surface,
    colorFillAlter: SOC_COLORS.surfaceSunken,
    colorSplit: SOC_COLORS.surfaceLine,

    // Нажимаемое получает контур 3:1, край карточки — волосяную линию.
    colorBorder: SOC_COLORS.borderControl,
    colorBorderSecondary: SOC_COLORS.border,

    colorText: SOC_COLORS.ink,
    colorTextSecondary: SOC_COLORS.inkSecondary,
    colorTextTertiary: SOC_COLORS.inkTertiary,
    colorTextQuaternary: SOC_COLORS.inkDisabled,

    borderRadius: SOC_RADIUS.control,
    borderRadiusSM: SOC_RADIUS.bar,
    borderRadiusLG: SOC_RADIUS.panel,

    controlHeight: SOC_DENSITY.controlHeight,
    controlHeightSM: SOC_DENSITY.controlHeightSm,

    fontFamily: SANS_STACK,
    fontSize: 13,
    lineHeight: 20 / 13,
    // Моноширинный — только числа, время, коды ИКАО, регистрации и номера
    // документов. Он здесь ради выравнивания колонок, а не ради вида.
    fontFamilyCode: MONO_STACK,

    // Движение — только отклик на действие. Въездов секций нет.
    motionDurationMid: '0.1s',
    motionDurationSlow: '0.15s',
  },
  components: {
    Table: {
      cellPaddingBlockSM: SOC_DENSITY.rowPaddingY,
      cellPaddingInlineSM: SOC_DENSITY.cellPaddingX,
      headerBg: SOC_COLORS.surfaceSunken,
      headerSplitColor: SOC_COLORS.border,
      borderColor: SOC_COLORS.surfaceLine,
    },
    Form: { itemMarginBottom: SOC_DENSITY.formItemGap },
    Card: { bodyPadding: SOC_DENSITY.cardPadding },
    Layout: {
      headerBg: SOC_COLORS.brandInk,
      headerHeight: SOC_DENSITY.chromeHeight,
      headerPadding: '0 16px',
      bodyBg: SOC_COLORS.surfacePage,
      siderBg: SOC_COLORS.surface,
    },
    Menu: { itemBg: SOC_COLORS.surface, itemHeight: 34 },
  },
};

/**
 * Кабинет заказчика — единственное место, где плотность отпущена.
 *
 * Внутренние экраны считают строки: диспетчер держит в поле зрения
 * сотню рейсов. Заказчик смотрит на одну свою поездку, и 13/20 там
 * выглядит мелким шрифтом договора, а не рабочим инструментом.
 */
export const portalTheme: ThemeConfig = {
  ...socTheme,
  token: { ...socTheme.token, fontSize: 15, lineHeight: 23 / 15 },
  components: {
    ...socTheme.components,
    Table: { ...socTheme.components?.Table, cellPaddingBlockSM: 8, cellPaddingInlineSM: 12 },
    Card: { bodyPadding: 16 },
  },
};
