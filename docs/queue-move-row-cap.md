# Online queue-move row cap

Retire, legacy `transfer-all` and the abort of a retirement move queued
messages between threads while the server is running. Each one refuses a move of
more than `ONLINE_QUEUE_MOVE_MAX_ROWS` (1000) queued messages. The count is taken
inside the same `IMMEDIATE` transaction that would do the move, so no row can be
added between the count and the move. A refusal leaves the database unchanged,
and the same request can be retried once the queue is smaller.

- Retire and transfer-all count every queued message on the source thread,
  including claimed and retry rows.
- Abort counts the rows it would give back to the retired thread: the rows that
  retire moved or forwarded and that are still queued on the successor, plus
  the rows that reached the successor through the retired thread's redirect.
  Other rows on the successor are not counted.

| Path                 | Refusal                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Retire (DB)          | `{ kind: "refused", reason: "source_queue_too_large" }`                                    |
| Transfer-all (DB)    | throws `SourceQueueTooLargeError` (`threadId`, `rows`); the transaction rolls back         |
| Abort (DB)           | `{ kind: "refused", reason: "abort_queue_too_large" }` when `maxReturnedRows` is passed    |
| HTTP                 | 409 `thread_not_writable` with `details.reason` set to the reason above                    |
| SDK                  | throws `BbHttpError`: `code` is `thread_not_writable`, `body.details.reason` is the reason |
| CLI (`transfer-all`) | prints `Error: HTTP 409: <message>` to stderr and exits 1                                  |
| CLI (`--json`)       | `{ "ok": false, "error": { "code": "thread_not_writable", "message": "HTTP 409: ..." } }`  |

The CLI does not forward `details.reason`. Its error envelope carries only
`code`, `message` and an optional `hint` for every command, so a script that
needs to tell this refusal apart from other `thread_not_writable` refusals has
to use the HTTP API or the SDK, or match the message text. The message names
the 1000-message limit. There is no CLI or SDK method for retire or abort; both
are HTTP routes only.

The abort cap is applied by the server's abort route, which passes
`maxReturnedRows`. The DB function stays uncapped when the argument is left out,
so the offline unretire script, which aborts with the server stopped, is not
capped. Offline claim release is not capped either. The cap targets callers
that hold the write lock while the server serves other writers.

Leaving `maxReturnedRows` out means no cap, so any new online caller of
`abortTransferOperation` must pass it. Today the only online caller is the
server's `abortRetirement`, which always passes `ONLINE_QUEUE_MOVE_MAX_ROWS` and
does not let an HTTP client change it.

### Redirected ingress

A retired thread keeps accepting messages: each new message is redirected to the
successor and recorded against the retirement. Retire's own count does not
bound these rows, so a retirement of an empty or small thread can build up
any number of rows to give back. Abort counts them, and once there are more than
1000 the online abort is refused until enough of them are sent, moved or
deleted. Nothing refuses or warns about the build-up while it happens. The
offline unretire script can still abort at any size.

## Why 1000

The online bounds stay as designed: a move must finish within 2500 ms (half of
the 5000 ms busy timeout), and no concurrent writer may wait more than 3000 ms.
The 1000-row caps bound transaction size in moved or returned rows. They do
not guarantee latency or writer fairness, or bound bytes, attachment work,
target size or historical abort-ledger work; see
[What the timing claim covers](#what-the-timing-claim-covers).

The deepest queue measured on a live deployment was 3 rows (p99 3), in one
snapshot. A cap of 1000 is about 333 times that depth. That sample does not
prove ordinary use never reaches the cap, but nothing observed so far comes
near it.

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
host are not bounded by it.

Abort was measured separately on the same host, with the same row shape, at
load1 between 10.4 and 11.6 and with no competing writer. "keyed" retires the
rows and then aborts. "redirected" retires an empty thread, sends the rows
through its redirect and then aborts. At 1001 rows the keyed profile retired
1000 rows and redirected one; the redirected profile retired none and redirected
all 1001.

| Operation | Profile    | Rows | Result             | Runs (ms)           | Median (ms) |
| --------- | ---------- | ---- | ------------------ | ------------------- | ----------- |
| Abort     | keyed      | 250  | aborted, 250 back  | 314.2, 256.0, 254.4 | 256.0       |
| Abort     | keyed      | 500  | aborted, 500 back  | 492.1, 480.1, 477.3 | 480.1       |
| Abort     | keyed      | 1000 | aborted, 1000 back | 918.0, 841.1, 811.9 | 841.1       |
| Abort     | keyed      | 1001 | refused            | 14.0, 12.5, 12.5    | 12.5        |
| Abort     | redirected | 250  | aborted, 250 back  | 277.7, 240.0, 248.0 | 248.0       |
| Abort     | redirected | 500  | aborted, 500 back  | 489.6, 534.0, 549.3 | 534.0       |
| Abort     | redirected | 1000 | aborted, 1000 back | 869.5, 868.3, 846.4 | 868.3       |
| Abort     | redirected | 1001 | refused            | 11.4, 9.8, 13.5     | 11.4        |

An earlier partial run at load1 between 12.7 and 14.4 measured the keyed abort
of 1000 rows at 1174.4, 835.9 and 1218.4 ms. Abort gives rows back one at a
time, at roughly 0.85 to 1.2 ms per row here, close to transfer-all. The same
load caveat applies: an independent uncapped abort of 10,000 redirected rows
took 41.9 s at load1 above 50, about 4.2 ms per row, so a 1000-row abort at
that load would exceed 2500 ms. These per-row costs are host- and
shape-specific.

The V6 gate does not test the abort cap: its own abort step runs uncapped and
is informational. The abort cap is covered by the DB unit tests and the server
route test.

Refusal times in the retire and transfer-all table are the uncontended samples
above. A retire or transfer-all refusal is one indexed count, but the count
reads every source row, and its transaction first waits for the write lock
behind any other writer. Under the V6 gate's concurrent writers, 1001-row
refusals took 3.7 and 9.0 ms in one review run and 11.6 and 1.3 ms in another
(retire and transfer-all). An abort refusal first reads the retirement's ledger
and the successor's owned rows; the uncontended samples above took 9.8 to
14.0 ms.

## What the timing claim covers

V6 is **FAILED** (bead mk-fcg1). Two controlled reruns are complete on head
`2670f98e7bc1e3b791f17bf5098bcfaf932b6463` and main
`69aba32c605fc7ae1982315c9fc438a7d8f1fb08`:

- The first enforced load1 below 8 throughout each scenario. It obtained
  0 valid head runs of 6 required and spent the void budget. It failed for
  lack of valid runs, not a measured latency breach.
- The second admitted each run only when load1 was below 8 at run start;
  once a run was admitted, it could not be voided at any subsequent load.
  It retained 12 admitted runs, 6 per target. Head failed 2 of 6: run 1
  `s4a.writers_progress_after` and run 7 `s4a.writers_progress_before`.
  Main failed 1 of 6: run 8 `s4b.writers_progress_after`. Every failure was
  an S4 writer-progress check. Those failed scenarios started at load1 8.49
  (head run 1, S4a), 20.03 (head run 7, S4a) and 12.02 (main run 8, S4b).
  Load1 rose well above 8 within admitted runs, reaching 20.93.
  S5 passed in all 12 admitted runs: call times were 862–1918 ms and the
  slowest writer wait was 2533 ms, within S5's 2500 ms call and 3000 ms
  writer bounds. S4 permitted 4500 ms writer latency and recorded waits of
  4133.1 ms (head run 1, S4a) and 3232.4 ms (main run 8, S4b).
  No scenario-specific latency bound failed in any admitted run.

The bounds are unchanged. V6 is not claimed passed; any pass would have been
scoped to runs admitted at load1 below 8 at run start. Run admission neither
maintains low load nor guarantees fairness. The original successful
10,000-row criterion is superseded and was never reported passed.

The historical campaign on head `80e58f8a7` had an S5 transfer-all call of
3813 ms and a 4720 ms writer wait while load1 rose from 8.04 to 17.18 across
that step. That breach remains on record; the later S5 results do not erase it.
Higher load is a plausible explanation for that breach, not an established
cause.

Pre-existing SQLite busy-handler starvation was independently reproduced in
a bare reproducer. This strongly supports pre-existing starvation as the
shared S4 failure explanation, but does not prove causality in the exact
failed runs or exclude every contribution from this PR. No PR-specific cause
has been identified.

## Mitigation and rollout gates

Merging the row caps is mitigation only, with V6 FAILED; it does not accept
recovery or authorize rollout. Above-cap offline release and live kill
switch/quiesce verification remain separate rollout gates. V7 is closed as
run: 52 checks passed, 13 negative controls were caught and provenance passed
33/33. Its exit 3 reflects the accepted grouping-loss limitation, not a
rehearsed handoff; no final script digest or handoff was established. The
unretire script remains held behind the separate operational gates.

The actual server switch is `ALEPH_TRANSFER_RETIRE=off`. It blocks **new
retirements only**: it does not block transfer-all, abort, existing retirement
replays or existing redirects, and it does not stop ordinary writers or fix
S4 starvation. Omitting it enables new retirements. Before deployment, verify
the actual server environment and switch behavior and separately verify
quiescence; source inspection alone is not live operational evidence.
