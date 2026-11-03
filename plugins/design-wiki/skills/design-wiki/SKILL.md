---
name: design-wiki
description: Read a project's design wiki pages and create, edit, resolve, delete or link pins (sticky notes on a page or claim) through the plugin RPC.
---

Enable Design Wiki in Settings → Plugins. The Design Wiki page and each thread's Design Wiki tab show the pages under `docs/wiki/src` of the project's repository. Pins are notes on a page or on one claim of it. They are saved in plugin storage, scoped to the project, and never edit the repository's Markdown.

The plugin exposes `projects`, `list`, `page`, `pins`, `createPin`, `updatePin`, `deletePin` and `linkPinThread` through its typed `designWikiRpcContract` and the generic plugin RPC SDK/CLI. Pass the input in a JSON file.

List a project's pins, each with its anchor (`page`, `claim`, `detached` or `unverified`) and linked thread IDs:

```json
{ "projectId": "project-id" }
```

```sh
bb plugin rpc call bb--design-wiki pins --input-file pins.json --json
```

Create a pin on a page with `"claim": null`. For a claim pin, copy the claim target from the page's `claims` (`label`, `context`, `ordinal`, `groupSize`). The server re-reads the page and refuses a claim that no longer matches with `stale-claim` or `unknown-claim`; a missing page gives `page-missing`.

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

A pin whose claim changed or disappeared is returned with a `detached` anchor and keeps its note. Pins do not create task cards or answer decision cards yet.
