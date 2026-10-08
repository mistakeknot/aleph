# Online queue-move row cap

Retire and legacy `transfer-all` move a thread's queued messages to another
thread while the server is running. Both refuse a source thread that holds more
than `ONLINE_QUEUE_MOVE_MAX_ROWS` (1000) queued messages. The count includes
claimed and retry rows, and it is taken inside the same `IMMEDIATE` transaction
that would do the move, so no row can be added between the count and the move.
A refusal leaves the database unchanged.

| Path              | Refusal                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| Retire (DB)       | `{ kind: "refused", reason: "source_queue_too_large" }`                            |
| Transfer-all (DB) | throws `SourceQueueTooLargeError` (`threadId`, `rows`); the transaction rolls back |
| HTTP, CLI and SDK | 409 `thread_not_writable` with `details.reason: "source_queue_too_large"`          |

Offline paths (unretire, abort, offline claim release) are not capped. The cap
targets callers that hold the write lock while the server serves other writers.

## Why 1000

The online bounds stay as designed: a move must finish within 2500 ms (half of
the 5000 ms busy timeout), and no concurrent writer may wait more than 3000 ms.
The cap is sized so that a move at the cap fits those bounds with margin.

The deepest queue measured on a live deployment was 3 rows (p99 3). A cap of
1000 is about 333 times that depth, so ordinary use never reaches it.

## Measurements

Host- and shape-specific: one 32-core Linux development host, load1 between 5
and 9, file-backed scratch databases in WAL mode, each row carrying two ready
attachment references. Three runs per size; times are the call only, after
seeding. "claimed20" claims the first 20% of rows, which retire turns into
slots and transfer-all skips.

| Operation    | Profile   | Rows | Result                 | Runs (ms)              | Median (ms) |
| ------------ | --------- | ---- | ---------------------- | ---------------------- | ----------- |
| Retire       | unclaimed | 250  | retired, 250 moved     | 209.2, 190.3, 158.4    | 190.3       |
| Retire       | unclaimed | 500  | retired, 500 moved     | 318.4, 309.9, 317.3    | 317.3       |
| Retire       | unclaimed | 1000 | retired, 1000 moved    | 625.2, 677.7, 688.7    | 677.7       |
| Retire       | unclaimed | 1001 | refused                | 0.7, 0.8, 0.9          | 0.8         |
| Retire       | claimed20 | 250  | retired, 200 moved     | 267.9, 316.0, 315.3    | 315.3       |
| Retire       | claimed20 | 500  | retired, 400 moved     | 452.8, 356.1, 305.0    | 356.1       |
| Retire       | claimed20 | 1000 | retired, 800 moved     | 597.9, 635.7, 630.6    | 630.6       |
| Retire       | claimed20 | 1001 | refused                | 0.9, 0.7, 0.8          | 0.8         |
| Transfer-all | unclaimed | 250  | 250 moved              | 319.3, 336.6, 324.5    | 324.5       |
| Transfer-all | unclaimed | 500  | 500 moved              | 582.2, 551.1, 545.0    | 551.1       |
| Transfer-all | unclaimed | 1000 | 1000 moved             | 1072.3, 1051.3, 1056.9 | 1056.9      |
| Transfer-all | unclaimed | 1001 | refused                | 0.3, 0.4, 0.4          | 0.4         |
| Transfer-all | claimed20 | 250  | 200 moved, 50 skipped  | 213.7, 285.7, 242.4    | 242.4       |
| Transfer-all | claimed20 | 500  | 400 moved, 100 skipped | 513.0, 468.5, 472.4    | 472.4       |
| Transfer-all | claimed20 | 1000 | 800 moved, 200 skipped | 947.4, 1065.4, 1115.8  | 1065.4      |
| Transfer-all | claimed20 | 1001 | refused                | 0.3, 0.4, 0.3          | 0.3         |

Time grows linearly with rows: about 0.65 ms per row for retire and 1.05 ms per
row for transfer-all here. At the cap the slowest run (1115.8 ms) used 45% of
the 2500 ms bound. An independent run of the same shape on the same host under
heavy load (load1 between 24 and 40) measured retire at a median of 1773 ms for
1000 rows, so the margin shrinks with load. Transfer-all costs about 1.6 times
retire per row here and was not measured at the cap under that load; scaled by
that ratio it would exceed 2500 ms. The cap counts rows, not bytes or attachment
references, so larger rows, more references per row, a large target or a slower
host are not bounded by it. Refusal is a single count and costs under a
millisecond.
