# Button

Buttons in four kinds and three sizes; one primary per view.

Kinds: primary (`brand` fill, `on-brand` text), secondary (default; `surface` with `control-border` outline), ghost (no outline, `ink-2`), danger (secondary shape, `status-critical-fg` text and `status-critical-line` outline; filled red is not used). Sizes: `control-h-sm` 28px in table toolbars and cards, `control-h` 32px default, `control-h-lg` 40px on the login and the portal. Labels are 600 weight, sentence case, a verb.

Icons sit before the label at 14px. An icon-only button is square and needs `aria-label`.

In Ant Design this is `Button` with the theme from `guidelines/20-ant-design.md`; `type="primary"`, default, `type="text"` for ghost, `danger` for danger. Disabled buttons keep their width and show a tooltip that says why.
