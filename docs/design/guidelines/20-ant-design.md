# Ant Design mapping

How Contrail lands in the web client. The client keeps its rule that the base is the Ant Design theme through `ConfigProvider`, with a thin layer of CSS variables in `app.css`. Token names below match `tokens.json`; when a value changes here it changes there.

## 1. Fonts: self-hosted, not Google Fonts

The customer's servers are in Russia and the delivery kit installs offline, so production cannot depend on `fonts.googleapis.com`. Put the three variable fonts in `web/public/fonts/`:

| File | Source (OFL) | Axes kept |
|---|---|---|
| `GolosText-Variable.woff2` | `google/fonts` → `ofl/golostext/GolosText[wght].ttf` | wght 400–900 |
| `Geologica-Variable.woff2` | `google/fonts` → `ofl/geologica/Geologica[CRSV,SHRP,slnt,wght].ttf`, instanced to CRSV=0, SHRP=0, slnt=0 | wght 100–900 |
| `JetBrainsMono-Variable.woff2` | `google/fonts` → `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` | wght 100–800 |

The three files are already in `web/public/fonts/`. Conversion: `fontTools.varLib.instancer` for Geologica, then save with `flavor='woff2'` (needs `brotli`). Remove the IBM Plex / JetBrains `<link>` from `web/index.html` and add to the top of `app.css`:

```css
@font-face { font-family: 'Golos Text'; src: url('/fonts/GolosText-Variable.woff2') format('woff2'); font-weight: 400 900; font-display: swap; }
@font-face { font-family: 'Geologica'; src: url('/fonts/Geologica-Variable.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
@font-face { font-family: 'JetBrains Mono'; src: url('/fonts/JetBrainsMono-Variable.woff2') format('woff2'); font-weight: 100 800; font-display: swap; }
```

Preload the two text faces in `index.html`: `<link rel="preload" href="/fonts/GolosText-Variable.woff2" as="font" type="font/woff2" crossorigin>` and the same for JetBrains Mono.

## 2. CSS variables in `app.css`

Replace the v2 `:root` block with this one. Component CSS reads only these variables; no hex values below this block.

```css
:root {
  --canvas: #f3f5f9;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-sunken: #f7f8fb;
  --surface-hover: #eff3f9;
  --surface-selected: #e7effb;
  --line: #e2e7ef;
  --line-strong: #cdd5e1;
  --control-border: #7d8ba1;
  --ink: #0c1526;
  --ink-2: #4a566c;
  --ink-3: #636e86;
  --ink-disabled: #a3adbd;
  --brand: #004798;
  --brand-hover: #003a7e;
  --brand-press: #002e64;
  --on-brand: #ffffff;
  --brand-soft: #e6eef9;
  --brand-soft-ink: #003a7e;
  --chrome: #0a1f3f;
  --chrome-raised: #132c55;
  --chrome-active: #1d3c6e;
  --chrome-line: #22385f;
  --on-chrome: #ffffff;
  --on-chrome-muted: #9fb1cf;
  --chrome-accent: #7fb2ff;
  --mark-red: #bf131b;
  --on-mark-red: #ffffff;
  --badge: #c8202a;
  --on-badge: #ffffff;
  --mark-blue: #004798;
  --focus: #1a66d9;
  --status-neutral-fg: #4a566c;
  --status-neutral-bg: #eef1f6;
  --status-neutral-line: #d9dfe8;
  --status-neutral-dot: #8a96aa;
  --status-progress-fg: #0a4fb4;
  --status-progress-bg: #e6eefc;
  --status-progress-line: #c2d5f6;
  --status-progress-dot: #2f6fe0;
  --status-ready-fg: #0a6670;
  --status-ready-bg: #e0f4f5;
  --status-ready-line: #b0dfe3;
  --status-ready-dot: #12a1ad;
  --status-active-fg: #5a2fbf;
  --status-active-bg: #f0eafd;
  --status-active-line: #d9cbf8;
  --status-active-dot: #7c4dff;
  --status-done-fg: #156b3c;
  --status-done-bg: #e4f4ea;
  --status-done-line: #b7e1c6;
  --status-done-dot: #22a35a;
  --status-cancelled-fg: #545e6e;
  --status-cancelled-bg: #f0f2f5;
  --status-cancelled-line: #d8dde5;
  --status-cancelled-dot: #a0a9b8;
  --status-critical-fg: #b0121c;
  --status-critical-bg: #fdeaeb;
  --status-critical-line: #f5c0c3;
  --status-critical-dot: #e5323b;
  --status-warning-fg: #8f4c05;
  --status-warning-bg: #fff1da;
  --status-warning-line: #f3d29b;
  --status-warning-dot: #e8940f;
  --row-critical: #fff3f3;
  --row-seed: #f6f2fd;
  --demo-ink: #6a3fb0;
  --demo-bg: #f3edfc;
  --chart-1: #004798;
  --chart-2: #12a1ad;
  --chart-3: #e8940f;
  --chart-4: #7c4dff;
  --chart-5: #8a96aa;
  --chart-grid: #e8ecf2;
  --shadow-sticky: 0 1px 0 #e2e7ef, 0 4px 8px -6px rgba(12,21,38,0.18);
  --shadow-pop: 0 12px 28px -8px rgba(12,21,38,0.18), 0 2px 6px -2px rgba(12,21,38,0.10);
  --shadow-modal: 0 32px 64px -16px rgba(12,21,38,0.30), 0 0 0 1px rgba(12,21,38,0.06);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 999px;
  --control-h-sm: 28px;
  --control-h: 32px;
  --control-h-lg: 40px;
  --row-h: 36px;
  --row-h-compact: 32px;
  --topbar-h: 56px;
  --rail-w: 240px;
  --rail-w-collapsed: 64px;
  --gantt-row-h: 40px;
  --gantt-bar-h: 26px;
  --icon: 16px;
  --icon-sm: 14px;
  --font-display: "Geologica", "Golos Text", "Segoe UI", system-ui, sans-serif;
  --font-sans: "Golos Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
}

/* Night shift (optional). Set data-theme="dark" on <html> together with
   Ant Design's darkAlgorithm; see "Night shift" below. */
:root[data-theme="dark"] {
  --canvas: #0a1120;
  --surface: #111b2d;
  --surface-raised: #17233a;
  --surface-sunken: #0d1626;
  --surface-hover: #1a2740;
  --surface-selected: #18294a;
  --line: #223049;
  --line-strong: #2e3e5c;
  --control-border: #5d6e8c;
  --ink: #e7edf6;
  --ink-2: #a9b6ca;
  --ink-3: #8392ab;
  --ink-disabled: #536079;
  --brand: #6aa6ff;
  --brand-hover: #8cbaff;
  --brand-press: #a9cbff;
  --on-brand: #061227;
  --brand-soft: #14284a;
  --brand-soft-ink: #a9cbff;
  --chrome: #060c18;
  --chrome-raised: #111d33;
  --chrome-active: #1a2c4d;
  --chrome-line: #1a2741;
  --on-chrome: #eef3fb;
  --on-chrome-muted: #8293b0;
  --mark-red: #d8333b;
  --badge: #d8333b;
  --focus: #7fb2ff;
  --status-neutral-fg: #b3bfd1;
  --status-neutral-bg: #1b2538;
  --status-neutral-line: #2d3a52;
  --status-neutral-dot: #7a889f;
  --status-progress-fg: #94bdff;
  --status-progress-bg: #132745;
  --status-progress-line: #22406e;
  --status-progress-dot: #5b9cff;
  --status-ready-fg: #6fd6df;
  --status-ready-bg: #0f2a30;
  --status-ready-line: #17454c;
  --status-ready-dot: #2bbcc8;
  --status-active-fg: #c2a8ff;
  --status-active-bg: #221a45;
  --status-active-line: #382b6c;
  --status-active-dot: #9a76ff;
  --status-done-fg: #79d9a0;
  --status-done-bg: #0f2a1d;
  --status-done-line: #1b4630;
  --status-done-dot: #36c574;
  --status-cancelled-fg: #a3adbd;
  --status-cancelled-bg: #1a212e;
  --status-cancelled-line: #2b3443;
  --status-cancelled-dot: #6b7587;
  --status-critical-fg: #ff9a9f;
  --status-critical-bg: #3a1418;
  --status-critical-line: #5e2228;
  --status-critical-dot: #ff5c63;
  --status-warning-fg: #ffc46b;
  --status-warning-bg: #33230b;
  --status-warning-line: #553a12;
  --status-warning-dot: #f5a524;
  --row-critical: #2a1418;
  --row-seed: #1d1a33;
  --demo-ink: #c8b0ff;
  --demo-bg: #231b3d;
  --chart-1: #6aa6ff;
  --chart-2: #2bbcc8;
  --chart-3: #f5a524;
  --chart-4: #9a76ff;
  --chart-5: #7a889f;
  --chart-grid: #1d2a40;
  --shadow-sticky: 0 1px 0 #223049, 0 4px 8px -6px rgba(0,0,0,0.6);
  --shadow-pop: 0 12px 28px -8px rgba(0,0,0,0.7), 0 0 0 1px #2e3e5c;
  --shadow-modal: 0 32px 64px -16px rgba(0,0,0,0.8), 0 0 0 1px #2e3e5c;
  color-scheme: dark;
}
```

The existing row classes keep their names and switch to the new variables: `.soc-row-critical > td { background: var(--row-critical) }`, `.soc-row-current > td { background: var(--surface-selected) }`, `.soc-row-seed > td { background: var(--row-seed); font-style: italic }`. The global `:focus-visible` rule uses `var(--focus)`.

## 3. `theme.ts`

```ts
import { theme, type ThemeConfig } from 'antd';

/** Contrail v3. Names match tokens.json of the design system. */
export const SOC_COLORS = {
  chrome: '#0a1f3f',
  chromeRaised: '#132c55',
  chromeActive: '#1d3c6e',
  chromeLine: '#22385f',
  onChrome: '#ffffff',
  onChromeMuted: '#9fb1cf',
  chromeAccent: '#7fb2ff',
  markRed: '#bf131b',
  markBlue: '#004798',
  brand: '#004798',
  brandHover: '#003a7e',
  brandPress: '#002e64',
  onBrand: '#ffffff',
  brandSoft: '#e6eef9',
  brandSoftInk: '#003a7e',
  canvas: '#f3f5f9',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#f7f8fb',
  surfaceHover: '#eff3f9',
  surfaceSelected: '#e7effb',
  line: '#e2e7ef',
  lineStrong: '#cdd5e1',
  controlBorder: '#7d8ba1',
  ink: '#0c1526',
  ink2: '#4a566c',
  ink3: '#636e86',
  inkDisabled: '#a3adbd',
  focus: '#1a66d9',
  rowCritical: '#fff3f3',
  rowSeed: '#f6f2fd',
  badge: '#c8202a',
  demoInk: '#6a3fb0',
  demoBg: '#f3edfc',
  chartGrid: '#e8ecf2',
} as const;

export const SOC_COLORS_NIGHT: Record<keyof typeof SOC_COLORS, string> = {
  chrome: '#060c18',
  chromeRaised: '#111d33',
  chromeActive: '#1a2c4d',
  chromeLine: '#1a2741',
  onChrome: '#eef3fb',
  onChromeMuted: '#8293b0',
  chromeAccent: '#7fb2ff',
  markRed: '#d8333b',
  markBlue: '#004798',
  brand: '#6aa6ff',
  brandHover: '#8cbaff',
  brandPress: '#a9cbff',
  onBrand: '#061227',
  brandSoft: '#14284a',
  brandSoftInk: '#a9cbff',
  canvas: '#0a1120',
  surface: '#111b2d',
  surfaceRaised: '#17233a',
  surfaceSunken: '#0d1626',
  surfaceHover: '#1a2740',
  surfaceSelected: '#18294a',
  line: '#223049',
  lineStrong: '#2e3e5c',
  controlBorder: '#5d6e8c',
  ink: '#e7edf6',
  ink2: '#a9b6ca',
  ink3: '#8392ab',
  inkDisabled: '#536079',
  focus: '#7fb2ff',
  rowCritical: '#2a1418',
  rowSeed: '#1d1a33',
  badge: '#d8333b',
  demoInk: '#c8b0ff',
  demoBg: '#231b3d',
  chartGrid: '#1d2a40',
};

export const SOC_RADIUS = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;

export const SOC_DENSITY = {
  controlHeight: 32, controlHeightSm: 28, controlHeightLg: 40,
  rowHeight: 36, rowHeightCompact: 32,
  topbarHeight: 56, railWidth: 240, railWidthCollapsed: 64,
  contentPaddingX: 24, cardGap: 12,
} as const;

export const DISPLAY_STACK = '"Geologica", "Golos Text", "Segoe UI", system-ui, sans-serif';
export const SANS_STACK = '"Golos Text", "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO_STACK = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

function build(c: Record<keyof typeof SOC_COLORS, string>, dark = false): ThemeConfig {
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: c.brand,
      colorPrimaryHover: c.brandHover,
      colorPrimaryActive: c.brandPress,
      colorPrimaryBg: c.brandSoft,
      colorLink: c.brand,
      colorLinkHover: c.brandHover,
      colorInfo: c.brand,
      colorSuccess: '#22a35a',
      colorWarning: '#e8940f',
      colorError: '#b0121c',
      colorBgLayout: c.canvas,
      colorBgContainer: c.surface,
      colorBgElevated: c.surfaceRaised,
      colorFillAlter: c.surfaceSunken,
      colorFillTertiary: c.surfaceHover,
      colorBorder: c.controlBorder,
      colorBorderSecondary: c.line,
      colorSplit: c.line,
      colorText: c.ink,
      colorTextSecondary: c.ink2,
      colorTextTertiary: c.ink3,
      colorTextQuaternary: c.inkDisabled,
      colorTextPlaceholder: c.ink3,
      controlItemBgHover: c.surfaceHover,
      controlItemBgActive: c.surfaceSelected,
      controlOutline: c.brandSoft,
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
      boxShadow: '0 12px 28px -8px rgba(12,21,38,0.18), 0 2px 6px -2px rgba(12,21,38,0.10)',
      boxShadowSecondary: '0 12px 28px -8px rgba(12,21,38,0.18), 0 2px 6px -2px rgba(12,21,38,0.10)',
      motionDurationFast: '0.08s',
      motionDurationMid: '0.12s',
      motionDurationSlow: '0.16s',
      wireframe: false,
    },
    components: {
      Layout: { headerBg: c.surface, headerHeight: SOC_DENSITY.topbarHeight, headerPadding: '0 16px 0 24px', siderBg: c.chrome, bodyBg: c.canvas },
      Menu: {
        darkItemBg: c.chrome, darkSubMenuItemBg: c.chrome, darkPopupBg: c.chromeRaised,
        darkItemColor: c.onChromeMuted, darkItemHoverColor: c.onChrome, darkItemHoverBg: c.chromeRaised,
        darkItemSelectedBg: c.chromeActive, darkItemSelectedColor: c.onChrome, darkGroupTitleColor: c.onChromeMuted,
        itemHeight: 36, itemBorderRadius: SOC_RADIUS.sm, itemMarginInline: 10, iconSize: 16, groupTitleFontSize: 11,
      },
      Table: {
        headerBg: c.surfaceSunken, headerColor: c.ink2, headerSplitColor: 'transparent', headerBorderRadius: SOC_RADIUS.lg,
        rowHoverBg: c.surfaceHover, rowSelectedBg: c.surfaceSelected, rowSelectedHoverBg: c.surfaceSelected,
        borderColor: c.line, cellPaddingBlockSM: 8, cellPaddingInlineSM: 12, cellFontSizeSM: 13, footerBg: c.surfaceSunken,
      },
      Card: { headerHeight: 52, headerFontSize: 16, bodyPadding: 16, borderRadiusLG: SOC_RADIUS.lg },
      Button: { fontWeight: 600, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', defaultBorderColor: c.controlBorder, paddingInline: 14 },
      Input: { activeShadow: `0 0 0 3px ${c.brandSoft}` },
      Select: { activeOutlineColor: c.brandSoft, optionSelectedBg: c.surfaceSelected },
      DatePicker: { activeShadow: `0 0 0 3px ${c.brandSoft}` },
      Tabs: { inkBarColor: c.brand, itemColor: c.ink2, itemHoverColor: c.ink, itemSelectedColor: c.ink, horizontalItemGutter: 20, titleFontSize: 13 },
      Segmented: { trackBg: c.surfaceSunken, itemSelectedBg: c.surface, itemColor: c.ink2, itemSelectedColor: c.ink },
      Modal: { borderRadiusLG: SOC_RADIUS.xl, titleFontSize: 16 },
      Drawer: { footerPaddingBlock: 12 },
      Badge: { colorError: c.badge },
      Tooltip: { colorBgSpotlight: c.chrome },
      Tag: { defaultBg: c.surfaceSunken },
    },
  };
}

export const socTheme = build(SOC_COLORS);
export const socNightTheme = build(SOC_COLORS_NIGHT, true);

/** Client portal: same palette, relaxed density (body-lg, 40px controls). */
export const portalTheme: ThemeConfig = {
  ...socTheme,
  token: { ...socTheme.token, fontSize: 15, lineHeight: 24 / 15, controlHeight: 40 },
  components: { ...socTheme.components, Table: { ...socTheme.components?.Table, cellPaddingBlockSM: 10, cellPaddingInlineSM: 14 } },
};
```

The rail is an Ant Design `Menu` with `theme="dark"` inside a `Layout.Sider` (`width={240}`, `collapsedWidth={64}`).

## 4. `status-tokens.ts`

Keep the exports and maps; replace the values and add `dot`:

```ts
export const STATUS_TOKENS = {
  neutral: { color: '#4a566c', background: '#eef1f6', border: '#d9dfe8', dot: '#8a96aa' },
  progress: { color: '#0a4fb4', background: '#e6eefc', border: '#c2d5f6', dot: '#2f6fe0' },
  ready: { color: '#0a6670', background: '#e0f4f5', border: '#b0dfe3', dot: '#12a1ad' },
  active: { color: '#5a2fbf', background: '#f0eafd', border: '#d9cbf8', dot: '#7c4dff' },
  done: { color: '#156b3c', background: '#e4f4ea', border: '#b7e1c6', dot: '#22a35a' },
  cancelled: { color: '#545e6e', background: '#f0f2f5', border: '#d8dde5', dot: '#a0a9b8' },
  critical: { color: '#b0121c', background: '#fdeaeb', border: '#f5c0c3', dot: '#e5323b' },
  warning: { color: '#8f4c05', background: '#fff1da', border: '#f3d29b', dot: '#e8940f' },
} as const;
```

Night shift values for the same keys are `status-<s>-fg|bg|line|dot` in `tokens.json` (`dark`). Status rendering moves from Ant Design `Tag` to a `StatusPill` component (see its card) so the dot, radius and height match everywhere.

## 5. Night shift

Optional for the first demo. When enabled: `ConfigProvider theme={socNightTheme}`, set `document.documentElement.dataset.theme = 'dark'` so the CSS variables switch, and store the choice per user. The rail is darker than the canvas in Night shift on purpose. CLAUDE.md § 10 currently says no dark theme; changing that is the customer's call, so ship it behind a user setting, off by default.
