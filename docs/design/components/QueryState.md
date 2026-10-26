# QueryState

Loading, empty and error states, rendered inside the card or table that would hold the data.

The existing `QueryState` wrapper chooses the state; this card defines the look. Loading: skeleton bars (`ct-skel`) shaped like the content, never a lone spinner on a page. Empty: a small trajectory-arc drawing in `line-strong`, a title that says what is missing and a sentence that says how it appears, plus an action when the user can create the first record. Error: a title that says what failed, a sentence with the consequence and what still works, a `Повторить` button, and the error code with the time in `code-sm` `ink-3`.
