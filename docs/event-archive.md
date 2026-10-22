# Event archive

The event archive keeps `bb.db` small by moving the event history of
long-archived threads into compressed segment files under
`<dataDir>/event-archive/`. A moved thread is cold: its history, apart from the
few rows the server always keeps, is no longer in the `events` table. Reading,
unarchiving, or messaging a cold thread moves its history back first, so a
reader sees the same timeline after a short wait.

The archive is off by default. [configuration.md](configuration.md#event-archive)
lists the variables that turn it on and set its windows. With the variable
unset, nothing new moves, and cold threads still move back on read.

## What moves

A periodic sweep picks one thread at a time: archived for at least
`BB_EVENT_COLD_MIN_ARCHIVED_DAYS`, not moved back within
`BB_EVENT_COLD_REHOT_DAYS`, with a history no larger than
`BB_EVENT_COLD_MAX_THREAD_BYTES`, settled (no running turn, its environment
torn down, pruning caught up), and not in use by a reader or a write. The
sweep writes the segment file durably, then removes the rows in one
transaction that records the segment. A thread that becomes busy during a move
keeps its rows, and the attempt's file is recorded as aborted.

`<dataDir>/event-archive/manifest.jsonl` is an append-only, hash-chained record
of every move. Only the server writes it.

## Commands

```
bb admin event-archive status             Mode, cold threads, segments, files by class
bb admin event-archive rehydrate <id>     Move one thread's history back
bb admin event-archive rehydrate --all    Move every cold thread's history back
bb admin event-archive reconcile          Mark orphaned segments, repair manifest commits
```

Each accepts `--json`. Status and reconcile classify every file in the
directory:

| Class              | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `referenced`       | A cold thread in this database reads it                                         |
| `ended`            | Its thread was moved back or deleted                                            |
| `committed_no_row` | The manifest says a database once referenced it, but this one does not          |
| `uncertain`        | The manifest has only the start of the move: a crash, or a database from before |
| `aborted`          | The move was abandoned and this database has no record of it                    |
| `unknown`          | Neither the database nor the manifest knows the file                            |

## Backups, restores, and downgrades

- **The backup unit is `bb.db` plus `event-archive/`.** A cold thread's history
  is only in its segment file. A server move exports both.
- **Segment files are never deleted in this release.** `event-archive/` only
  grows, by at most the bytes of every finalized segment file, including
  aborted attempts that moved no rows; `status` reports the bytes per class.
  Removing files by hand can make a restored `bb.db` unreadable, because an
  older snapshot may reference a file the current database no longer does.
- **Never restore an older `manifest.jsonl` over a newer one.** Restore
  `bb.db` alone, or restore `bb.db` and `event-archive/` together into a fresh
  data directory, then run `reconcile`.
- **Before downgrading to a build without the event archive, run
  `bb admin event-archive rehydrate --all`** and check that it reports no
  failures. An older build cannot read cold threads.

## Turning it off

Unset `BB_EVENT_COLD_TIER` and restart the server: no new moves happen, and
cold threads still move back when read. To bring every thread back, run
`rehydrate --all`.
