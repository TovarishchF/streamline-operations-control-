# Contrail mockups: the reference for pixel matching

Every picture in the design system as real HTML, plus a PNG of how it renders. The HTML loads `frame.css` (all tokens as CSS variables and the fonts from `web/public/fonts/`), `../components/bundle.css` (every `ct-` component) and `contrail.js` (the Ant Design icon paths). Open any file straight from disk in Chrome.

| Mockup | Real screen | Reference PNG |
|---|---|---|
| `screens/01-login.html` | `/login` | `screens/01-login.png` (1440) |
| `screens/02-dashboard-dispatcher.html` | `/dashboards/dispatcher` | `screens/02-dashboard-dispatcher.png` (1440) |
| `screens/03-schedule.html` | `/schedule` | `screens/03-schedule.png` (1440) |
| `components/<Name>.html` | the component on any screen | `components/<Name>.png` (960) |

## Which source wins

1. **The HTML and CSS** give exact values: sizes, paddings, radii, colours, font weights. Read the classes a mockup uses and their rules in `bundle.css`. Never estimate a value from the PNG when the CSS states it.
2. **The PNG** shows the intended result. Use it to check composition, alignment and hierarchy.
3. **The guides** (`docs/design/README.md`, `components/*.md`) explain behaviour the picture cannot show: states, responsiveness, what is data-driven.

Mockups use demo text. The app shows seed data, so compare layout, sizes and styling, not the words or numbers.

## The loop for each screen

1. Open the mockup, list the `ct-` classes it uses and map each to the Ant Design theme token or the `app.css` rule that produces it (`guidelines/20-ant-design.md`). Do not copy `bundle.css` into the app wholesale.
2. Implement.
3. Screenshot the real screen with `e2e/design.spec.ts` at 1440 (`SOC_DESIGN_STEP=<step>`).
4. Read the reference PNG and the new screenshot one after the other. Write down every difference as a concrete measurement ("card header is 44px, mockup 52px"; "rail item text is ink, mockup on-chrome-muted"), fix them, then screenshot again. Stop after three passes and report what still differs and why.
5. Measure instead of eyeballing when in doubt: the mockup is a real page, so the same Playwright query works on both.

```ts
// Run against the mockup (file://…/docs/design/mockups/screens/03-schedule.html)
// and against http://localhost:4173/schedule, then compare the two outputs.
const probe = (sel: string) => page.locator(sel).first().evaluate((el) => {
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), pad: s.padding, radius: s.borderRadius,
           font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.split(',')[0]}`, color: s.color, bg: s.backgroundColor };
});
```

Typical pairs: `.ct-rail__item.is-active` ↔ `.ant-menu-item-selected`, `.ct-topbar` ↔ `.ant-layout-header`, `.ct-page-title` ↔ the page `h1`, `.ct-card__head` ↔ `.ant-card-head`, `.ct-table th` ↔ `.ant-table-thead th`, `.ct-btn--primary` ↔ `.ant-btn-primary`, `.ct-bar` ↔ the vis-timeline item.

## Limits

The mockups are drawn at desktop width only. Behaviour at 1024 and 390 px follows the Layout section of `docs/design/README.md`; there is no reference picture for it. The flight card and client portal have no mockup yet; build them from `guidelines/40-screens.md`.
