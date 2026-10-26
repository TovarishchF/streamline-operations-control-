# Banner

An inline notice above the content it concerns: conflicts, data freshness, integration status.

Kinds: info (`brand-soft` fill, `brand-soft-ink`), warning and critical (`status-<s>-bg` fill, `status-<s>-fg` title and icon, 1px inset `status-<s>-line`). The consumer provides an 18px Outlined icon, a title that states the count or the fact, an optional list of items (each with a `sm` pill, linked identifiers and one sentence), a note in `ink-2`, and at most one action.

Banners never use a coloured left border. They are not toasts: a banner stays while the condition holds. For a transient confirmation use an Ant Design `message`.
