# TopBar

The 56px bar above the content: where am I, find anything, what time is it, what needs me.

Left to right: breadcrumb (section in `ink-2`, page in `ink` 600); the command search trigger (`surface-sunken` field with placeholder `Рейс, борт, клиент, аэропорт…` and a `Ctrl K` hint) pushed right; the DEMO badge when `DEMO_DATA=true`; the dual clock (`08:13Z` then `11:13 MSK` in `ink-3`, from `useClock()`); the bell with a `badge` counter; the avatar with name and role.

It sits on `surface` with a `line` bottom border, not on `chrome`. Below 700px it keeps only the menu button, the page title, the bell and the avatar; search becomes an icon.
