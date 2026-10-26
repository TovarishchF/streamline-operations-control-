# NavRail

The navigation rail: nine sections in three groups on the dark `chrome` band, collapsible to icons.

Structure comes from `NAV_GROUPS` in `web/src/app/layout/navigation.ts` (Операции, Финансы, Система); visibility follows permissions. Each item is 36px, `radius-sm`, a 16px Outlined icon and a 13px label. States: rest `on-chrome-muted`; hover `chrome-raised` fill and `on-chrome` text; current `chrome-active` fill, `on-chrome` 600 text and the icon in `chrome-accent`. Counters (unread requests) are `badge` pills right-aligned.

Group labels are `overline` in `on-chrome-muted`. The brand block at the top is `topbar-h` tall so it lines up with the top bar. The footer holds the collapse toggle.

Collapsed (64px): icons only, a tooltip on hover with the label, counters become 8px dots, the logo becomes `SOC`. Below 1024px the rail opens as a drawer from the top bar menu button.
