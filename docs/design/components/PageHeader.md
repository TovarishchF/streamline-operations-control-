# PageHeader

The top of every screen: title, meta line, actions, and section tabs.

The consumer provides `title` (in `page-title`, Geologica 22/28), an optional `meta` row (date, record state pill, last update in `ink-3`), `actions` (secondary first, the single primary last) and optional `tabs` for sections with several screens (from `NavItem.children`).

Tabs are text with a 2px `brand` underline on the active one and an optional count chip. Tabs change screens; for views of the same data use a segmented control in the actions.

On a record page (flight, invoice) the title is the identifier in the mono family at the same size, followed by the status pill.
