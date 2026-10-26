# FlightStrip

A flight shown as a flight-progress strip: identity, leg, status and countdown in one row.

The consumer provides flight number, tail and type code, departure and arrival ICAO with ETD/ETA in UTC, the status token and label (with optional progress such as `4/6` services), and the countdown to ETD.

Layout: a 128px identity cell on `surface-sunken` (flight number in `code` 600 `brand`, tail and type in `code-sm` `ink-2`) separated by a dashed `line-strong` rule like a paper strip's tear line; the leg with large ICAO codes (`code` 15px 600) and a dashed arc between them; a side cell with the pill and the countdown `T−3:56`, which turns `status-warning-fg` under four hours.

Use it on the dashboard (upcoming departures), in the client portal (my trips) and on the flight card summary. Stack strips with 8px gaps; do not put them in a table.
