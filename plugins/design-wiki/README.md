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
  `updatePin`, `deletePin`, `linkPinThread`, `createPinTask`, `linkPinTask`,
  `unlinkPinTask`, `pinTasks`, `pinDecisions`, `answerPinDecision`).
- `tasks-client.ts`: the calls into the tasks plugin through
  `bb.sdk.plugins.callRpc`.
- `wiki-page.ts`, `wiki-discovery.ts`, `claims.ts`: parsing, discovery and claim
  extraction, free of host and UI code.
- `server.ts`: reads files through the host and stores pins in plugin storage.
- `pin-migrations.ts`, `pin-anchor.ts`: the `pins`, `pin_threads` and
  `pin_tasks` tables (migration 2 adds `pin_tasks`), and the check of a pin's claim against the page as it is now.
- `ui/wiki-page-view.tsx`: the page renderer, also exported as
  `bb-plugin-bb--design-wiki/page-view`.
- `ui/wiki-list-view.tsx`: the grouped list with status filter chips.
- `ui/wiki-browser.tsx`: `WikiBrowser`, the list plus page view for one project.
  The Wiki page renders it with `layout="split"` and the thread side panel with
  `layout="stacked"`; it also takes the current `threadId` (null on the Wiki page).
- `ui/pinned-page.tsx`: the pins section, the pin controls and the pin actions.
- `ui/pin-cards.tsx`: the cards on a pin, Make task, Link existing card and the
  card status refresh.
- `autarch-client.ts`, `ui/pin-decisions.tsx`: the Citadel (`autarch` plugin)
  client and the decision cards shown on a pin.
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

## Make task

"Make task" on a pin creates a card on the project's task board through the tasks
plugin and records it on the pin in the `pin_tasks` table (task id and display
key). The pin row then lists its cards. One pin may hold several cards.

- **Board.** The board is found through the tasks plugin's `listProjects`, taking
  the boards whose `linkedBbProjectId` is the pin's project. With none, the pin
  says no board is linked and nothing is created. With several, the pin asks
  which one and creates the card on that choice. With one, it is used.
- **Card.** The title is the first non-empty line of the note, cut to 120
  characters. The description is the note followed by a back-link: the pin id, the
  project, the page, the claim label when there is one, and a Markdown link to the
  page's panel path.
- **Recovery.** If the card is created but recording it on the pin fails, the pin
  says so and shows "Link existing card" with the new card's key filled in.
  "Link existing card" accepts any card key on a board linked to the pin's
  project, so a pin can also pick up a card made elsewhere.
- **Status.** Each card shows its key (a button that opens it in Tasks), title and
  status, the agent threads on it with their live status, its pull requests with
  their state (open, draft, merged, closed), and a count of threads that could not
  be read. A card deleted in Tasks reads "Card removed"; an unreadable card, or a
  card moved to a board that is no longer linked to the project, shows its message
  and keeps the key without showing its title, status, threads or pull requests. "Unlink" stops showing a card on the pin and
  leaves the card alone.
- **Freshness.** The plugin reads the cards through its own `pinTasks` query,
  tagged per project. Making, linking, unlinking and deleting a pin refresh it
  at once. Because the tasks plugin cannot invalidate this plugin's tags, status
  changes made in Tasks show up on a 30-second refresh while any pin holds a card
  (no timer when none does) and when the window regains focus.

Board resolution, the back-link format, the title rule, "Link existing card", the
"Card removed" state, `unlinkPinTask` and the 30-second refresh are design
choices, not part of an earlier spec.

## Decision cards on pins

Cards are derived each time they are read; nothing new is stored.

- **Which cards.** A pin anchored to a claim shows the cards the claim's marker
  names. A pin anchored to a page shows the page's `card`. A detached or
  unverified pin shows neither. Every pin also shows the cards in its
  `pin_tasks` rows. A key reached two ways is listed once.
- **State.** Each card is read through the `autarch` (Citadel) plugin's
  `cardState`. A card Citadel does not know is "missing"; one that cannot be
  reached is "unavailable"; a card that is not open is shown as closed.
- **Answering.** `cardState` carries no decision id, revision or options, so for
  open cards the plugin also reads Citadel's existing `listAsks` and matches the
  entry by key. A card with a single-choice ask (kind `decide`, no `questions`,
  no option needing approval) shows its question, the recommendation and one
  button per option. Anything else shows why it cannot be answered here and an
  Open card button.
- **The pick.** A click calls `answerPinDecision`, which checks that the key is
  one of the pin's cards and that Citadel still lists it as waiting, then calls
  Citadel's `pick` with the revision the page showed and a fresh `pick_id`. A
  stale revision is reported ("This decision changed...") and the card is
  re-read; the plugin never retries and never picks on its own.
- **Freshness.** `pinDecisions` is tagged per project and refreshes when a pin
  or a pin's cards change, on window focus, and every 30 seconds while any pin
  holds a card.

Answering in place is a design choice, not an earlier ruling. The `autarch`
plugin is not modified; if it is absent or unreachable the cards show as
unavailable and nothing is answered.

## Tests

```bash
cd plugins/design-wiki && pnpm exec vitest run --config vitest.config.ts
pnpm exec turbo run typecheck test --filter=bb-plugin-bb--design-wiki
```
