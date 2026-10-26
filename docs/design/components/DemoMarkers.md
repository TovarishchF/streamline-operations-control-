# DemoMarkers

The markers that keep the demo stand honest: the DEMO badge and the SEED tag.

The badge (`ct-demo`) is a pill with a diagonal hatch of `demo-bg` and `surface`, outlined and lettered in `demo-ink`, uppercase 11px 700. It appears in the top bar and on the login card whenever `DEMO_DATA=true`, and never otherwise.

The SEED tag marks records written by the demo generator (`source='seed'`): mono 10px on `demo-bg`. Such rows also take `row-seed` and italic text, and the audit author reads `System (демо-генератор)`. Exports carry a DEMO stamp in `demo-ink`.

These markers are required by CLAUDE.md § 4; restyle them only within these tokens.
