Reads a project's design wiki and shows it as a Wiki page, with persistent pins.

## What you get

- A project-level Design Wiki page in the navigation, with a project picker.
- Pages grouped as critical user journeys and requirements, with status filter
  chips, and each row showing id, title, status, updated date and card key.
- A page view that renders the Markdown. Claim markers in the body (`Ruled —
  CARD`, `Design choice`, `Open`) take the same status colors as the page status,
  and card keys link to the Tasks card.
- Pins: sticky notes on a page or a single claim that stay across reloads. Keep
  one as a note, or discuss it now: in a thread the pin links to that thread, and
  on the Wiki page it opens a draft in the project. A pin whose claim has changed
  is marked detached.
- Make task on a pin: creates a card on the project's task board with a back-link
  to the page, and shows the card, its agent threads, pull requests and merge
  status on the pin. A pin can hold several cards, and a card created but not
  recorded can be linked afterwards.
- A malformed page appears as an error row naming the file and the problem; the
  rest of the wiki still loads.

The same list and page view open as a Design Wiki tab in a thread's side panel,
for the thread's project. A project with no `docs/wiki` shows an empty state.

Enable Design Wiki under Installed plugins. It reads
`docs/wiki/src/cujs/*.md` and `docs/wiki/src/requirements/*.md` from the project's
checkout and never edits them. Pins are saved in the plugin's own storage.
