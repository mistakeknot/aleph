---
name: design-wiki
description: Read a project's design wiki pages and create, edit, resolve, delete or link pins (sticky notes on a page or claim) through the plugin RPC.
---

Enable Design Wiki in Settings → Plugins. The Design Wiki page and each thread's Design Wiki tab show the pages under `docs/wiki/src` of the project's repository. Pins are notes on a page or on one claim of it. They are saved in plugin storage, scoped to the project, and never edit the repository's Markdown.

The plugin exposes `projects`, `list`, `page`, `pins`, `createPin`, `updatePin`, `deletePin`, `linkPinThread`, `createPinTask`, `linkPinTask`, `unlinkPinTask` and `pinTasks` through its typed `designWikiRpcContract` and the generic plugin RPC SDK/CLI. Pass the input in a JSON file.

List a project's pins, each with its anchor (`page`, `claim`, `detached` or `unverified`) and linked thread IDs:

```json
{ "projectId": "project-id" }
```

```sh
bb plugin rpc call bb--design-wiki pins --input-file pins.json --json
```

Create a pin on a page with `"claim": null`. For a claim pin, derive the claim target from the page's `body` and `claims`. Each claim marker has `label` and `line` (1-based, in `body`). Set `label` to the marker's label and `context` to the trimmed text of line `line` of `body`. The claims with the same `label` and `context` form a group in page order: set `groupSize` to the group's size and `ordinal` to the marker's 0-based position in it. The server re-reads the page and refuses a claim that no longer matches with `stale-claim` or `unknown-claim`; a missing page gives `page-missing`.

```json
{
  "projectId": "project-id",
  "pageId": "cuj-example",
  "claim": null,
  "body": "Check this journey against the new flow."
}
```

```sh
bb plugin rpc call bb--design-wiki createPin --input-file create-pin.json --json
```

The note is at most 4000 characters after trimming; an empty or longer note fails with `invalid-body` and creates nothing. `updatePin` changes the note (`body`) or resolves and reopens the pin (`resolved`), and fails with `not-found` for an unknown pin. `deletePin` removes a pin and its thread links. `linkPinThread` records that a thread of the same project discusses the pin and fails with `thread-not-found` or `wrong-project`. Every mutation takes the `projectId` and only reaches that project's pins.

A pin whose claim changed or disappeared is returned with a `detached` anchor and keeps its note. Pins do not answer decision cards yet.

`createPinTask` makes a card on the task board linked to the project (through the tasks plugin) and records it on the pin. The card title is the first line of the note and its description ends with a Markdown link back to the page, after the pin, project and page ids. It returns `{ ok: true, task: { id, key } }` or `{ ok: false, reason, message }`. `no-board` means the project has no linked board; `board-required` returns `boards` and needs `taskProjectId` to pick one; `tasks-unavailable` and `tasks-refused` mean the tasks plugin could not be reached or refused the card; `not-linked` means the card was created but not recorded, and returns its `task` so `linkPinTask` can record it.

```json
{ "projectId": "project-id", "pinId": "pin-id" }
```

`linkPinTask` takes a `taskKey` and records an existing card of a board linked to the project (`wrong-board`, `task-not-found` otherwise). `unlinkPinTask` stops showing a card on a pin and leaves the card alone. `pinTasks` lists the recorded cards of a project with their live status, threads, pull requests and merge state; a deleted card has `state: "removed"` and one that cannot be read, or that now sits on a board not linked to the project, `state: "unavailable"` with its key only. A pin may hold several cards.
