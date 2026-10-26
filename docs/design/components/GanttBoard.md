# GanttBoard

The day plan: aircraft rows grouped by type, flights as status-coloured bars on a UTC scale, a red now-line.

The consumer provides the aircraft list (grouped by type), flights with ETD/ETA in UTC, status token and conflict flags, the visible window (day, three days, week) and the current time from `useClock()`.

Scale header: `surface-sunken`, 2-hour ticks in `code-sm` `ink-3`. Group rows: 30px, `surface-sunken`, type name in caps 11px. Aircraft rows: 40px (`gantt-row-h`), tail in `code`, a 6px dot after the tail for aircraft flags (critical: AOG; warning: permit expiring). Bars: 26px (`gantt-bar-h`), `radius-xs`, `status-<s>-bg` fill, 1px `status-<s>-line` outline, a 3px leading edge in `status-<s>-dot`, label `SLG-1126 UUDD→UNNT` in `code-sm` with the number in 600. Cancelled bars are struck through. Conflicts add a 2px `status-critical-dot` outline; the selected bar a 2px `focus` outline.

The now-line is 2px `mark-red` with a time flag at the top. Hour gridlines are `chart-grid`. Bars open the flight card on click and show a popover with ETD/ETA and services on hover.

Built on the existing vis-timeline: apply these styles through its class hooks rather than replacing the library.
