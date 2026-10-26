# DataText

Typographic rules for identifiers, times, money and routes, implemented by `Mono`, `UtcTime`, `MoneyText` and a new `Route` primitive.

Identifiers (flight number, tail, ICAO code, document number) use `code` (JetBrains Mono 12/20 500). A flight number that opens the flight card is coloured `brand`, underlined on hover only.

Times use `code` with the zone always present: `12:40Z`, or local as `15:40` followed by `LT UTC+3` in `ink-3` 11px. Dates in tables are `23.10 08:13Z` when within the current year.

Money uses the sans family with tabular figures, weight 500, the currency code after it in `ink-3` 12px; negative amounts use a true minus `−` and `status-critical-fg`. Amounts arrive from the server as Decimal strings; the component only formats.

Routes show two ICAO codes in `code` with a 22×10 arc glyph in `ink-3` between them; in dense tables a plain `→` is acceptable.
