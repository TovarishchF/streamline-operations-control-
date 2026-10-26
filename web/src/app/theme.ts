import { theme, type ThemeConfig } from 'antd';

/**
 * Тема Ant Design.
 *
 * Значения — из дизайн-системы «Streamline Contrail», версия 3
 * (`docs/design/`, `guidelines/20-ant-design.md`). Имена совпадают
 * с `tokens.json` системы: цвет здесь и цвет там обязаны сходиться,
 * иначе система перестаёт быть источником правды.
 *
 * Самописного CSS-фреймворка нет: база — тема через ConfigProvider,
 * сверху тонкий слой переменных в `app.css`.
 *
 * Цвета обвязки, поверхностей и текста объявлены здесь, а не в компонентах:
 * цвет, заданный в JSX, невозможно поменять во всей системе одним движением.
 * Смыслы статусов живут отдельно — `shared/ui/status-tokens.ts`.
 */
export const SOC_COLORS = {
  // ── Обвязка: рельс навигации и панель знака на входе ─────────────────
  chrome: '#0a1f3f',
  chromeRaised: '#132c55',
  chromeActive: '#1d3c6e',
  chromeLine: '#22385f',
  onChrome: '#ffffff',
  onChromeMuted: '#9fb1cf',
  chromeAccent: '#7fb2ff',
  /** Красная полоса знака. В интерфейсе — только линия «сейчас» на планшете:
   *  красный в области данных занят критическим статусом. */
  markRed: '#bf131b',
  markBlue: '#004798',

  // ── Действие ──────────────────────────────────────────────────────────
  brand: '#004798',
  brandHover: '#003a7e',
  brandPress: '#002e64',
  onBrand: '#ffffff',
  brandSoft: '#e6eef9',
  brandSoftInk: '#003a7e',

  // ── Поверхности ───────────────────────────────────────────────────────
  canvas: '#f3f5f9',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  /** Шапка таблицы, итоговая строка, поле только для чтения. */
  surfaceSunken: '#f7f8fb',
  surfaceHover: '#eff3f9',
  surfaceSelected: '#e7effb',

  // ── Границы ───────────────────────────────────────────────────────────
  line: '#e2e7ef',
  lineStrong: '#cdd5e1',
  /** Контур нажимаемого: поле ввода и кнопка обязаны иметь 3:1 к фону. */
  controlBorder: '#7d8ba1',

  // ── Текст ─────────────────────────────────────────────────────────────
  ink: '#0c1526',
  ink2: '#4a566c',
  /** Единицы, время в списках, подсказки. Не для того, что нужно прочесть,
   *  чтобы действовать. */
  ink3: '#636e86',
  inkDisabled: '#a3adbd',

  focus: '#1a66d9',

  // ── Подсветка строк. Больше подсветок не вводится. ────────────────────
  rowCritical: '#fff3f3',

  badge: '#c8202a',
  chartGrid: '#e8ecf2',
} as const;

/** Радиусы: полоса Gantt — xs, нажимаемое — sm, карточка — lg, окно — xl. */
export const SOC_RADIUS = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;

/** Плотность. Мишень 32 px: диспетчер работает мышью двенадцать часов. */
export const SOC_DENSITY = {
  controlHeight: 32,
  controlHeightSm: 28,
  controlHeightLg: 40,
  rowHeight: 36,
  rowHeightCompact: 32,
  topbarHeight: 56,
  railWidth: 240,
  railWidthCollapsed: 64,
  contentPaddingX: 24,
  cardGap: 12,
} as const;

/** Geologica — один раз на экран: заголовок страницы, числа KPI, заголовок входа. */
export const DISPLAY_STACK = '"Geologica", "Golos Text", "Segoe UI", system-ui, sans-serif';
export const SANS_STACK = '"Golos Text", "Segoe UI", system-ui, -apple-system, sans-serif';
/** Моноширинный — только идентификаторы: номера рейсов и документов,
 *  регистрации, коды ИКАО/ИАТА, время Z. Не суммы и не текст. */
export const MONO_STACK = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

const SHADOW_POP = '0 12px 28px -8px rgba(12,21,38,0.18), 0 2px 6px -2px rgba(12,21,38,0.10)';

export const socTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: SOC_COLORS.brand,
    colorPrimaryHover: SOC_COLORS.brandHover,
    colorPrimaryActive: SOC_COLORS.brandPress,
    colorPrimaryBg: SOC_COLORS.brandSoft,
    colorLink: SOC_COLORS.brand,
    colorLinkHover: SOC_COLORS.brandHover,
    colorInfo: SOC_COLORS.brand,
    colorSuccess: '#22a35a',
    colorWarning: '#e8940f',
    colorError: '#b0121c',
    colorBgLayout: SOC_COLORS.canvas,
    colorBgContainer: SOC_COLORS.surface,
    colorBgElevated: SOC_COLORS.surfaceRaised,
    colorFillAlter: SOC_COLORS.surfaceSunken,
    colorFillTertiary: SOC_COLORS.surfaceHover,
    // Нажимаемое получает контур 3:1, край карточки — волосяную линию.
    colorBorder: SOC_COLORS.controlBorder,
    colorBorderSecondary: SOC_COLORS.line,
    colorSplit: SOC_COLORS.line,
    colorText: SOC_COLORS.ink,
    colorTextSecondary: SOC_COLORS.ink2,
    colorTextTertiary: SOC_COLORS.ink3,
    colorTextQuaternary: SOC_COLORS.inkDisabled,
    colorTextPlaceholder: SOC_COLORS.ink3,
    controlItemBgHover: SOC_COLORS.surfaceHover,
    controlItemBgActive: SOC_COLORS.surfaceSelected,
    controlOutline: SOC_COLORS.brandSoft,
    controlOutlineWidth: 3,
    borderRadius: SOC_RADIUS.sm,
    borderRadiusSM: SOC_RADIUS.xs,
    borderRadiusLG: SOC_RADIUS.lg,
    controlHeight: SOC_DENSITY.controlHeight,
    controlHeightSM: SOC_DENSITY.controlHeightSm,
    controlHeightLG: SOC_DENSITY.controlHeightLg,
    fontFamily: SANS_STACK,
    fontFamilyCode: MONO_STACK,
    fontSize: 13,
    lineHeight: 20 / 13,
    fontSizeHeading1: 22,
    fontSizeHeading2: 16,
    fontSizeHeading3: 14,
    boxShadow: SHADOW_POP,
    boxShadowSecondary: SHADOW_POP,
    // Движение — только отклик на действие. Въездов секций нет.
    motionDurationFast: '0.08s',
    motionDurationMid: '0.12s',
    motionDurationSlow: '0.16s',
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: SOC_COLORS.surface,
      headerHeight: SOC_DENSITY.topbarHeight,
      headerPadding: '0 16px 0 24px',
      siderBg: SOC_COLORS.chrome,
      bodyBg: SOC_COLORS.canvas,
    },
    Table: {
      headerBg: SOC_COLORS.surfaceSunken,
      headerColor: SOC_COLORS.ink2,
      headerSplitColor: 'transparent',
      headerBorderRadius: SOC_RADIUS.lg,
      rowHoverBg: SOC_COLORS.surfaceHover,
      rowSelectedBg: SOC_COLORS.surfaceSelected,
      rowSelectedHoverBg: SOC_COLORS.surfaceSelected,
      borderColor: SOC_COLORS.line,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 12,
      cellFontSizeSM: 13,
      footerBg: SOC_COLORS.surfaceSunken,
    },
    Card: {
      headerHeight: 52,
      headerFontSize: 16,
      headerPadding: 16,
      bodyPadding: 16,
      borderRadiusLG: SOC_RADIUS.lg,
    },
    Button: {
      fontWeight: 600,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      defaultBorderColor: SOC_COLORS.controlBorder,
      paddingInline: 14,
      paddingInlineSM: 10,
      // Малая кнопка — тот же радиус нажимаемого, что и обычная.
      borderRadiusSM: SOC_RADIUS.sm,
      contentFontSizeSM: 12,
      // Крупная (40 px) — вход и кабинет заказчика: 14 px и поля 18.
      // Радиус как у обычной: `borderRadiusLG` здесь — радиус карточек.
      paddingInlineLG: 18,
      contentFontSizeLG: 14,
      borderRadiusLG: SOC_RADIUS.sm,
    },
    Input: {
      activeShadow: `0 0 0 3px ${SOC_COLORS.brandSoft}`,
      inputFontSizeLG: 14,
      paddingInlineLG: 12,
      borderRadiusLG: SOC_RADIUS.sm,
    },
    Select: { activeOutlineColor: SOC_COLORS.brandSoft, optionSelectedBg: SOC_COLORS.surfaceSelected },
    DatePicker: { activeShadow: `0 0 0 3px ${SOC_COLORS.brandSoft}` },
    Tabs: {
      inkBarColor: SOC_COLORS.brand,
      itemColor: SOC_COLORS.ink2,
      itemHoverColor: SOC_COLORS.ink,
      itemSelectedColor: SOC_COLORS.ink,
      horizontalItemGutter: 20,
      titleFontSize: 13,
    },
    Segmented: {
      trackBg: SOC_COLORS.surfaceSunken,
      itemSelectedBg: SOC_COLORS.surface,
      itemColor: SOC_COLORS.ink2,
      itemSelectedColor: SOC_COLORS.ink,
    },
    Modal: { borderRadiusLG: SOC_RADIUS.xl, titleFontSize: 16 },
    Drawer: { footerPaddingBlock: 12 },
    Badge: { colorError: SOC_COLORS.badge },
    Tooltip: { colorBgSpotlight: SOC_COLORS.chrome },
    Tag: { defaultBg: SOC_COLORS.surfaceSunken },
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
  token: { ...socTheme.token, fontSize: 15, lineHeight: 24 / 15, controlHeight: 40 },
  components: {
    ...socTheme.components,
    Table: { ...socTheme.components?.Table, cellPaddingBlockSM: 10, cellPaddingInlineSM: 14 },
  },
};
