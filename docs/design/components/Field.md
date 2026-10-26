# Field

Form fields: label above, 32px control, help or error below; plus the segmented control.

The consumer provides the label (with a red `*` for required), the control and either help text (`ink-3`) or an error message (`status-critical-fg`, replaces help). Inputs have a `control-border` outline that meets 3:1 on `surface` and `canvas`; focus switches the border to `brand` with a 3px `brand-soft` ring. Errors set the border to `status-critical-fg`.

Time inputs take UTC and show the local equivalent as help text. Code inputs (ICAO, tail) render their value in `code`.

Segmented controls switch views of the same data (Планшет / Таблица, Сутки / Трое суток / Неделя, density). They are not tabs: tabs change the screen, segments change the view.

Forms are one column in drawers and modals, two or three columns on full pages with 16px row gap and 14px column gap.
