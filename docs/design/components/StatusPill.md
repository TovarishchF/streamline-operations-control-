# StatusPill

The single way to show a domain status: a 22px pill with a dot, the status word, and the semantic's four tokens.

Props: `token` (`neutral | progress | ready | active | done | cancelled | critical | warning`), `label` (the translated status word), optional `size` (`md` default, `sm` 18px for table cells and dense lists). Wrappers `FlightStatusPill status=` and `ServicePill status=` resolve the token through `FLIGHT_STATUS_TOKENS` and `SERVICE_ORDER_STATUS_TOKENS`.

Colours: text `status-<s>-fg`, fill `status-<s>-bg`, 1px inset outline `status-<s>-line`, dot `status-<s>-dot`. `active` adds a 3px halo around the dot (airborne / happening now). `critical` sets the label in 600 weight.

Do: always pass the word; colour alone never carries the status. Use `sm` in tables. Use `ct-tag` (mono, neutral) for codes such as aircraft type or `RVSM`, not a pill.

Don't: invent a ninth colour, use a pill as a button, or put two pills for one status.
