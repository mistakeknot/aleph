The sidebar thread list, as a plugin.

## What you get

- **Pinned** and **Threads** sections, plus the custom sections you create.
- Organize by project, by machine, or chronologically, with sort by updated, created, or title.
- Nested child threads, worktree grouping, drag to reorder, pin, nest, and move between sections.
- Inline rename, keyboard jump shortcuts, and the same status glyphs bb draws elsewhere.
- Agent provider icons before thread titles, controlled by Organize → Rows → Provider icons.
- A metadata line under thread titles where plugins show details such as the pull request number, controlled by Organize → Rows → Metadata while the Thread row metadata experiment is on.
- Unread threads listed above read ones, controlled by Organize → Groups → By read status.
- An optional hull designation badge on each thread row, read from `hull-designations.json` in bb's data directory (or the file named by `BB_HULL_DESIGNATIONS_FILE`): a JSON array of approved rows with a `designation` and any of `projectId`, `threadId`, `name` and an optional `aliases` string array. A thread resolves its badge in order: a row for its `threadId`; the title prefix (the text before the first ` | `) matched to an approved row's `name` or `aliases` after lowercasing and keeping only letters and digits, skipping a name that maps to two different designations; then a row for its `projectId`. Only approved rows with a designation show, and a missing or invalid file shows no badges. The `listHullDesignations` RPC returns `{ designations, names }`; `shared/hull-names.ts` holds the normalization and resolver.

## How it works

The plugin reads bb's live thread view through the plugin SDK and stores your layout choices (organization, sort, section order, collapsed groups) in its own storage, synced to every open window. Sections and thread moves go through bb's public API, so `bb thread section` and this list always agree.

Disable the plugin to hide the list; another thread-list plugin can take its place under Settings → Appearance.
