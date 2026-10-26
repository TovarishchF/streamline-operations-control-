# Streamline Contrail — дизайн-система SOC (v3)

Contrail is the interface system for **SOC (Streamline Operations Control)**, the dispatch and handling platform built for Streamline Flight Support. It is version 3 of the SOC design system and replaces the v2 values in `web/src/app/theme.ts`, `web/src/app/app.css` and `web/src/shared/ui/status-tokens.ts`. The status semantics, token keys and the 32px density target are carried over from the code; the palette, type, chrome and component treatment are new.

The product is sold to people who run private jets for a living. It has to look like an instrument they would trust at 03:00Z with an AOG on the board, and like a product worth paying for when the sales demo opens on the dashboard. Every rule below serves one of those two moments.

## Principles

1. **The chrome frames, the data speaks.** The navigation rail is the only dark, saturated area (`chrome`). Everything inside the content area is quiet: `canvas`, `surface`, hairlines. Colour inside the content area means state or action, never decoration.
2. **One colour, one meaning, everywhere.** The eight status semantics (`neutral`, `progress`, `ready`, `active`, `done`, `cancelled`, `critical`, `warning`) have one colour set each. A status looks identical in the Gantt, a table, a pill, a flight strip and the mobile app. Status always carries a word as well as a colour.
3. **Every time has a zone.** Times render as `12:40Z` or `15:40 LT (UTC+3)`; a bare `12:40` is a bug.
4. **One display moment per screen.** Geologica (the display face) appears once per screen: the page title, the KPI numbers, or the login headline. Everything else is Golos Text.
5. **Dense by default, calm on demand.** Internal screens run at 13/20 with 32px controls and 36px rows. The client portal and the login run at 15/24 with 40px controls.

## Content and voice

Russian is the primary language, English has parity through i18next; write both. Use sentence case for every label, title and button (`Создать рейс`, not `Создать Рейс`). Buttons name the action they perform: `Выставить счёт`, `Подтвердить конфликт`, `Отменить рейс`; never `ОК`, `Да` or `Применить` alone. The confirmation toast repeats the verb in the past tense: `Счёт выставлен`.

Address the user with the polite plural implied by imperative mood (`Выберите борт`), never with `ты`. No emoji anywhere, including notifications. No exclamation marks.

Error text says what happened and what to do, with the system code underneath in `code-sm`: `Сервер ЦБ не ответил за 10 секунд. Последний курс от 22.10 продолжает действовать.` then `FX_PROVIDER_TIMEOUT · 08:12Z`. Empty states say what will appear and how it gets there: `Заявки из кабинета заказчика появятся здесь сразу после отправки.`

Industry vocabulary stays as dispatchers say it: AOG, turnaround, RVSM, ETD/ETA, slot, handling. Do not translate ICAO codes, tail registrations or aircraft type designators.

Formatting: thousands separated by a narrow no-break space (`1 284 500,00`), decimal comma in Russian, decimal point in English, currency code after the amount in `ink-3` (`412 800,00 RUB`). Dates `23.10.2026` in Russian, `23 Oct 2026` in English. Durations `T−3:56` for countdowns, `38 мин` in prose.

## Colour

Light (`Day`) is the default theme and the one to ship first. `Night shift` is fully specified for the 24-hour operations room and is enabled by Ant Design's `darkAlgorithm` plus the dark token values; it is optional for the first sale.

**Chrome.** The rail and the login brand panel use `chrome` with `on-chrome` labels, `on-chrome-muted` group labels and inactive items, `chrome-raised` on hover, `chrome-active` for the current item, `chrome-accent` for the current item's icon and for focus on chrome. The top bar is not chrome: it is `surface` with a `line` bottom border, so the dark frame reads as one vertical band.

**Surfaces.** The content area is `canvas`. Panels, cards, tables and inputs are `surface` with a `line` border. Table headers, totals and read-only fields are `surface-sunken`. Hover is `surface-hover`; the selected row or item is `surface-selected`. Overlays (popover, dropdown, modal, command palette) are `surface-raised` with a shadow.

**Ink.** Body text is `ink`. Labels, column headers and meta lines are `ink-2`. Units, timestamps in lists and placeholders are `ink-3`; never use `ink-3` for anything the user must read to act. All three pass 4.5:1 on `canvas`, `surface`, `surface-sunken` and `surface-raised` in both themes.

**Brand.** `brand` is the Streamline cobalt from the logo (`#004798`). It fills primary buttons, colours links and flight numbers, and draws the active tab underline. One primary button per view. `brand-soft` with `brand-soft-ink` is the tinted fill for info banners, the selected segment and avatars.

**Identity colours.** `mark-red` is the red stripe under the wordmark. It is used for the Gantt now-line and its time flag, and on the cover. It is never a button, a link or a status: red in the content area is reserved for `critical`. `mark-blue` is the logo blue for brand panels and illustrations.

**Status.** Each semantic has four tokens: `status-<s>-fg` (text and icon), `status-<s>-bg` (pill and bar fill), `status-<s>-line` (pill and bar outline) and `status-<s>-dot` (the indicator dot and the bar's leading edge). The mapping from domain states lives in `shared/state-machines/*.json` and `status-tokens.ts` and does not change:

| Semantic | Flight | Service order |
|---|---|---|
| `neutral` | planned | draft |
| `progress` | in_work | ordered |
| `ready` | ready_for_departure | confirmed |
| `active` | in_flight, arrived | in_progress |
| `done` | completed | completed |
| `cancelled` | cancelled | cancelled |
| `critical` | aog | rejected |
| `warning` | (flags: low margin, permit expiring, deadline near) | |

Row tints are limited to three: `row-critical` (AOG, SLA breach), `surface-selected` (selected or current), `row-seed` (records written by the demo generator). No other row colouring.

**Charts.** ECharts series take `chart-1` to `chart-5` in order, gridlines `chart-grid`, axis labels `ink-3`, values `ink`. A chart that shows statuses (flights by status) uses the status dots instead and labels each bar with the status word.

## Typography

Three families, all with full Cyrillic, all self-hosted as variable woff2 files (see `guidelines/20-ant-design.md`):

- **Geologica** (`font-display`) for `page-title`, `kpi`, `display` and `display-xl`. One display moment per screen.
- **Golos Text** (`font-sans`) for everything else. It was drawn for Russian public-service interfaces and holds up at 12–13px. Money columns use Golos with `font-variant-numeric: tabular-nums`, which is set on the root.
- **JetBrains Mono** (`font-mono`) for identifiers only: flight numbers, tail registrations, ICAO/IATA codes, document numbers and Zulu times (`code`, `code-sm`). Not for amounts, not for prose.

Use the type styles by name. `body` is the default for internal screens; `body-lg` for the client portal and login. `label` for form labels, column headers, KPI labels and pill text. `overline` (uppercase via CSS) only for rail group labels. Headings get `text-wrap: balance`.

## Layout

The shell is a two-column grid: the rail at `rail-w` (240px; `rail-w-collapsed` 64px when collapsed), then the main column with the `topbar-h` (56px) top bar and the content area. Content padding is `space-6` (24px) left and right and 20px on top on desktop, `space-4` below 700px. Cards in a grid are separated by 12px; page regions by `space-5` (20px).

Breakpoints: from 1024px the rail is visible; below 1024px it becomes a drawer opened from a menu button in the top bar; below 700px the top bar keeps only the menu button, the page title, the bell and the avatar, and the command search becomes an icon button. Tables never squeeze below their content: they scroll horizontally inside their own card.

The page header is the same on every screen: `page-title`, a meta line in `caption` with the date or record state, actions on the right (secondary actions before the single primary one), and section tabs under it when the section has more than one screen.

## Shape and depth

Radii: `radius-xs` (4) for Gantt bars and keyboard hints, `radius-sm` (6) for controls and rail items, `radius-md` (8) for popovers, banners and flight strips, `radius-lg` (12) for cards, tables and the Gantt board, `radius-xl` (16) for modals, the command palette and the login card, `radius-pill` for status pills, counters, avatars and the DEMO badge.

Cards, tables and tiles are separated by a `line` border, never by shadow. Shadows exist only for things that float: `shadow-sticky` for a stuck table header, `shadow-pop` for popovers and toasts, `shadow-modal` for modals, drawers and the command palette.

Focus is a 2px solid `focus` outline with 2px offset on light surfaces and `chrome-accent` on the rail. It is visible on every interactive element.

## Motion

Motion only answers an action. Hover and press transitions are 120ms ease-out on colour and background. Overlays fade and rise 4px over 160ms. Skeletons shimmer at 1.4s. No section entrances, no animated numbers, no parallax. With `prefers-reduced-motion: reduce` everything except the overlay fade is off.

## Iconography

Icons are `@ant-design/icons`, Outlined only, already a dependency. 16px (`icon`) in controls and the rail, 14px (`icon-sm`) in pills, table cells and small buttons. The rail uses `ScheduleOutlined`, `InboxOutlined`, `EnvironmentOutlined`, `MailOutlined`, `DollarOutlined`, `BarChartOutlined`, `TeamOutlined`, `BookOutlined`, `ApiOutlined`. Icons in the previews here are the exact path data of `@ant-design/icons-svg` 4.4. No emoji, no filled or two-tone variants, no custom icon set.

Routes use a small arc glyph between ICAO codes (see `DataText` and `FlightStrip`); in plain tables a `→` is enough.

## The logo

Use the customer's files from `web/public/brand/` unchanged: `streamline-fs-white.png` on `chrome` (the rail, the login panel), `streamline-fs.png` on white only (documents, exports, the client portal header). Never recolour, redraw, crop or place the colour logo on a tinted or dark ground. In the rail it sits at 30px height with `SOC` beside it after a `chrome-line` divider; at 64px collapsed width the rail shows `SOC` in Geologica instead. The logo's swoosh is the system's only motif: the login panel and empty states draw thin trajectory arcs in `chrome-line` or `line-strong` with one dashed arc in `chrome-accent`.

## Demo honesty

These rules are part of the contract with the customer and survive the redesign. With `DEMO_DATA=true` the top bar shows the hatched `Демо-стенд` badge (`demo-ink`, `demo-bg`), the login card shows it too, and every export carries the DEMO stamp. Records with `source='seed'` render in `row-seed` with italic text and a `SEED` tag; the audit author reads `System (демо-генератор)`. Demo client and vendor names are invented; airport codes and aircraft types are real.

## Reading order

This folder is the repository copy of the Contrail design system. Read this README, then `guidelines/20-ant-design.md` (the exact `theme.ts`, `app.css` and font changes), `guidelines/30-rollout.md` (order of work and checks), `guidelines/40-screens.md`, then `components/<Name>.md` for each component you touch. `tokens.json` is the source of every value; `tokens.css` is the same values as CSS variables. `components/bundle.css` is a reference rendering of every component in plain CSS with `ct-` classes; in the web client the same look comes from the Ant Design theme plus a small layer in `app.css`, not from copying that file wholesale. Logo rules: `components/Logo.md` and `logos.md`. The fonts are already in `web/public/fonts/`.
