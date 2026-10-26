# KpiTile

A dashboard number: label, value, optional sparkline, and one line of context.

The consumer provides `label`, `value` (formatted server-side), optional `unit`, `trend` (array of numbers for the sparkline), `delta` (signed, with its comparison period) and `tone` (`default | warning | critical`).

Value is `kpi` (Geologica 30/36 500, tabular). The sparkline is 96×32 with a `brand-soft` area, a 1.5px `brand` line and an emphasised end point. `tone` colours only the value (`status-warning-fg` / `status-critical-fg`) and may add a small pill in the label row; the tile itself keeps its `line` border and `surface` fill. No coloured borders, no icons in circles.

Use four per row on desktop, two on tablets, one on phones. Only figures someone acts on belong in a tile.
