# CommandPalette

Ctrl K / ⌘K opens a palette that jumps to any flight, tail, client, airport or action.

A 640px `surface-raised` panel with `radius-xl` and `shadow-modal`, centred at 20% from the top over a dimmed page. A 56px input row with a search icon and an `Esc` hint; results grouped under small `ink-3` headings (Борта, Рейсы, Клиенты, Аэропорты, Действия); each result 40px with a 28px icon tile, the identifier in `code`, context in `ink-2` and a status pill where relevant. The active result is `surface-selected` with its icon tile in `brand`. A footer lists keyboard hints.

The consumer provides the search function (debounced 150ms against the existing list endpoints) and the action list (filtered by permissions). Arrow keys move, Enter opens, Tab jumps groups. Built as an Ant Design `Modal` without header and footer.
