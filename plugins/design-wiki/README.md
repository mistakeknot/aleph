# Design Wiki

A Wiki page for a project's design wiki, with persistent pins (sticky notes) on
pages and claims. The plugin never edits the repository's Markdown. Disabled by
default; enable it with `bb plugin enable bb--design-wiki`.

## Source

The server reads Markdown files from the project's repository root on its
default host:

- `docs/wiki/src/cujs/*.md`: critical user journeys
- `docs/wiki/src/requirements/*.md`: requirements

A missing `docs/wiki` directory shows an empty state, not an error.

## Page front matter

Each file starts with a YAML front matter block, parsed strictly:

| Field     | Required         | Value                                         |
| --------- | ---------------- | --------------------------------------------- |
| `id`      | yes              | `cuj-*` in `cujs`, `req-*` in `requirements`  |
| `status`  | yes              | `ruled`, `design-choice` or `open`            |
| `card`    | when `ruled`     | Task card key                                 |
| `source`  | yes              | Where the page's content comes from           |
| `updated` | yes              | `YYYY-MM-DD`                                  |

The title is the first `#` heading of the body. A file that fails any check is
listed as an error row and skipped. Duplicate ids are errors too.

## Claim markers

Bold or table-cell text that starts with `Ruled — CARD`, `Design choice` or
`Open` is a claim marker. It takes the status color of the matching page status,
and card keys inside any body text link to the Tasks card.

## Layout

- `contract.ts`: RPC contract (`projects`, `list`, `page`, `pins`, `createPin`,
  `updatePin`, `deletePin`, `linkPinThread`).
- `wiki-page.ts`, `wiki-discovery.ts`, `claims.ts`: parsing, discovery and claim
  extraction, free of host and UI code.
- `server.ts`: reads files through the host and stores pins in plugin storage.
- `pin-migrations.ts`, `pin-anchor.ts`: the `pins` and `pin_threads` tables, and
  the check of a pin's claim against the page as it is now.
- `ui/wiki-page-view.tsx`: the page renderer, also exported as
  `bb-plugin-bb--design-wiki/page-view`.
- `ui/wiki-list-view.tsx`: the grouped list with status filter chips.
- `ui/wiki-browser.tsx`: `WikiBrowser`, the list plus page view for one project.
  The Wiki page renders it with `layout="split"` and the thread side panel with
  `layout="stacked"`; it also takes the current `threadId` (null on the Wiki page).
- `ui/pinned-page.tsx`: the pins section, the pin controls and the pin actions.
- `ui/claim-sites.ts`: maps each claim to its place in the rendered page.
- `app.tsx`: the Wiki navigation panel and the thread side panel tab.

## Thread side panel

A "Design Wiki" tab in every thread's side panel shows the same list and page
view for the thread's project. Choosing a page replaces the list, with a "Back to
pages" control. A project without `docs/wiki/src` shows the empty state, and a
thread without a project says it has no design wiki. The panel offers the same
pins as the Wiki page.

## Pins

A pin is a note anchored to a page, or to one claim on it. Pins are stored in the
plugin's own database, so they persist across reloads, and are scoped to the
project. They never change the repository's Markdown.

- **Add.** "Pin this page" in the page's Pins section, or the pin control beside
  a claim. The note is up to 4000 characters.
- **Keep as note** is the default save. **Discuss now** saves the pin and opens a
  conversation about it.
- **Resolve, reopen, edit, delete** from the pin row.
- **Anchor.** The server re-parses the page when a pin is created and refuses a
  claim that no longer matches (`stale-claim`, `unknown-claim`). A claim is
  identified by its label, its surrounding text, its position among identical
  claims and the size of that group. A pin whose claim has changed or vanished is
  shown as detached, with the reason; one whose page is gone is listed under
  "Detached pins" in the page list. The page view also re-checks claim pins
  against the page it is showing.
- **Discuss now in a thread** records a link between the pin and that thread. The
  pin then reads "Discussed in this thread", and other linked threads are buttons
  that open them.
- **Discuss now on the Wiki page** opens a new draft in the project with the page,
  claim and note as the prompt. No thread exists yet, so the draft is not linked
  to the pin, and the message says so.
- **Claims without an inline control.** If the rendered page cannot be matched to
  every claim, the pin controls move into a "Claims without an inline control"
  menu. It sits at the end of the page body, not in the page header; this is a
  design choice.

Make task (a task card for the coordinator, with card, thread, PR and merge
status) and decision cards on pins are later slices and are not part of this
version.

## Tests

```bash
cd plugins/design-wiki && pnpm exec vitest run --config vitest.config.ts
pnpm exec turbo run typecheck test --filter=bb-plugin-bb--design-wiki
```
