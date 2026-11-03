# Design Wiki

A read-only Wiki page for a project's design wiki. Disabled by default; enable it
with `bb plugin enable bb--design-wiki`.

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

- `contract.ts`: RPC contract (`projects`, `list`, `page`).
- `wiki-page.ts`, `wiki-discovery.ts`, `claims.ts`: parsing, discovery and claim
  extraction, free of host and UI code.
- `server.ts`: reads files through the host.
- `ui/wiki-page-view.tsx`: the page renderer, also exported as
  `bb-plugin-bb--design-wiki/page-view`.
- `ui/wiki-list-view.tsx`: the grouped list with status filter chips.
- `ui/wiki-browser.tsx`: `WikiBrowser`, the list plus page view for one project.
  The Wiki page renders it with `layout="split"` and the thread side panel with
  `layout="stacked"`; nothing else differs.
- `app.tsx`: the Wiki navigation panel and the thread side panel tab.

## Thread side panel

A "Design Wiki" tab in every thread's side panel shows the same list and page
view for the thread's project. Choosing a page replaces the list, with a "Back to
pages" control. A project without `docs/wiki/src` shows the empty state, and a
thread without a project says it has no design wiki. The panel is read-only.

## Tests

```bash
cd plugins/design-wiki && pnpm exec vitest run --config vitest.config.ts
pnpm exec turbo run typecheck test --filter=bb-plugin-bb--design-wiki
```
