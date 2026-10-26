# Rollout for the sales demo

The demo opens on the login, then the dispatcher dashboard, then the day plan, then a flight card. Work in that order of visibility, foundations first. Each step is one commit; each ends with a Playwright screenshot of the affected screens into `artifacts/screenshots/` so the change is checked by looking, not by assuming.

## Step 1. Foundations (everything changes at once)

Fonts, the `app.css` variable block, `theme.ts` and `status-tokens.ts` exactly as `guidelines/20-ant-design.md` gives them. No component code yet.

Done when: every screen renders in Golos Text with Cyrillic intact (no fallback serif or system font), primary buttons are `brand` cobalt, status tags pick up the new colours, `make lint` and `vitest` pass (update the `status-tokens.test.ts` expectations to the new values, not the other way round).

## Step 2. The shell

`AppLayout`, `NavRail`, the header. Rail on `chrome` with the white logo lockup, nine items in three groups, collapse to 64px with the state stored per user. Top bar on `surface`: breadcrumb, command search trigger (`Ctrl K`), DEMO badge, dual clock `08:13Z | 11:13 MSK`, bell with counter, avatar with name and role. See the `AppShell`, `NavRail` and `TopBar` cards.

Done when: screenshots at 1440, 1024 and 390px wide show no horizontal page scroll, the rail is a drawer below 1024px, and the current rail item is the only filled item.

## Step 3. StatusPill and data primitives

One `StatusPill` component replaces `FlightStatusTag`, `ServiceStatusTag` and `GenericStatusTag` (keep those as thin wrappers so call sites do not change). `Mono`, `UtcTime`, `MoneyText` follow the `DataText` card: mono only for identifiers and Zulu times, money in Golos with tabular figures and the currency code in `ink-3`.

Done when: the same status looks identical in a table, the Gantt and the dashboard.

## Step 4. Login

Split screen per the `LoginScreen` card: brand panel on `chrome` with the logo, the `display-xl` headline and the arc motif; the form on `canvas` at 40px controls. Keep the existing auth logic, 2FA and registration links.

## Step 5. Dispatcher dashboard

Greeting in `display`, four `KpiTile`s, `Ближайшие вылеты` as `FlightStrip`s, `Требует внимания` list with one action button per row. Data comes from the existing dashboard endpoint; no numbers computed in JSX.

## Step 6. Day plan (Gantt)

Bars per the `GanttBoard` card: status fill and outline, 3px leading edge in the status dot colour, flight number in bold mono plus route, red outline for conflicts, `mark-red` now-line with its `08:13Z` flag, aircraft-type group rows on `surface-sunken`. The conflict summary above the board becomes a `Banner`.

## Step 7. Tables and cards everywhere else

`DataTable`: 36px rows, sticky `surface-sunken` header, right-aligned money, the three row tints only. `PageHeader` on every screen. Empty, loading and error states through `QueryState`. This is mostly theme work after steps 1–3.

## Step 8. Command palette (if time allows)

`Ctrl K` / `⌘K` opens the palette (Ant Design `Modal` without footer, custom content). Groups: Рейсы, Борта, Клиенты, Действия; searches the existing list endpoints with a 150ms debounce. It is the strongest single "modern product" signal in a demo; it is also the safest to drop.

## Checks before the demo

- Contrast: status fg on its bg and on `surface` is at least 4.5:1 in the shipped theme (the values here already pass; do not re-tint).
- Times: grep the client for formatted times without `Z` or `LT`.
- DEMO markers: badge in the top bar and on the login, `SEED` rows italic and tinted, DEMO stamp on PDF and XLSX exports.
- No leftover v2 values: grep for `#0f5fd1`, `#0d2b4e`, `IBM Plex`.
