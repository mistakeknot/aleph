Reads a project's design wiki and shows it as a read-only Wiki page.

## What you get

- A project-level Design Wiki page in the navigation, with a project picker.
- Pages grouped as critical user journeys and requirements, with status filter
  chips, and each row showing id, title, status, updated date and card key.
- A page view that renders the Markdown. Claim markers in the body (`Ruled —
  CARD`, `Design choice`, `Open`) take the same status colors as the page status,
  and card keys link to the Tasks card.
- A malformed page appears as an error row naming the file and the problem; the
  rest of the wiki still loads.

Enable Design Wiki under Installed plugins. It reads
`docs/wiki/src/cujs/*.md` and `docs/wiki/src/requirements/*.md` from the project's
checkout and changes nothing.
