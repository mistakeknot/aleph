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
- `ui/wiki-page-view.tsx`: the page renderer. It is exported as
  `bb-plugin-bb--design-wiki/page-view` so a thread side panel can reuse it.
- `ui/wiki-list-view.tsx`, `app.tsx`: the list and the navigation panel.

## Tests

```bash
cd plugins/design-wiki && pnpm exec vitest run --config vitest.config.ts
pnpm exec turbo run typecheck test --filter=bb-plugin-bb--design-wiki
```
