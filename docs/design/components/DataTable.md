# DataTable

The dense table used on every list: 36px rows, sticky header, mono identifiers, right-aligned money.

The existing `DataTable` wrapper keeps its API; this card defines its look. Header: `surface-sunken`, `label` style in `ink-2`, sentence case, sticky with `shadow-sticky` once scrolled. Rows: 36px (`row-h`), or 32px in compact density; `line` dividers; hover `surface-hover`. Columns: identifier first (link-coloured `code`), money and counts right-aligned, status as a `sm` pill.

Row tints, and only these: `surface-selected` for selected rows, `row-critical` for AOG or SLA breach, `row-seed` plus italic plus a `SEED` tag for demo-generator records. Totals in a `surface-sunken` footer with a `line-strong` top border.

The table sits in a card (`radius-lg`, `line` border) and scrolls horizontally inside it on narrow screens.
