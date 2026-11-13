# Observed wake outcomes

The server exposes GET /api/v1/threads/:id/wake-outcomes. The CLI
`bb thread wake-outcomes <threadId> [--cursor <cursor>] --json` and SDK
`threads.experimental_wakeOutcomes({ threadId, cursor? })` use that same report.
Omit cursor for the newest page. Pass the returned nextCursor unchanged to
read older turns; null means there is no further page. Human CLI output also
prints the next cursor. Invalid, unsupported-version, and wrong-thread cursors
return HTTP 400.
These observations measure effects, not usefulness, accepted outcomes, savings,
or wasted work. Read-only research can be useful.

Only turn/input/accepted.clientRequestId joins a request to a turn.
Acceptance order determines the primary request. Persisted wakeRef means the
earliest accepted primary reference, including null; mixed causes, different
references, and overflow never replace it with a later reference.
Coalesced queues retain their first constituent reference before acceptance.
Sources and requests are capped at 32 each, with explicit truncation and unknown
attribution coverage. Mixed sources report unknown aggregate cause while retaining
their individual causes. Retry request IDs, attempts, and retained causes remain
separate. Unaccepted requests do not produce wake outcomes.

Each request names its first accepting turn. Counts deduplicate top-level item
IDs and include failed calls; nested calls and progress events are excluded.
Post-accept counts use the first observation of each call, so a call already in
progress when a steer arrives is excluded. Later acceptance or explicit steering
marks a partial observation window. First-turn comparisons should use only the
first accepting turn and exclude partial windows.

changedAnything is true only for successful completed file changes with actual
added or removed diff lines, or explicit completed turn-scoped acknowledgments.
The acknowledgment writer accepts file, commit, task, card, and outbound_message
effect kinds, records only acknowledged changes, and deduplicates operation IDs
within the exact turn. Invocation, tool names, shell commands, response prose,
and successful no-op acknowledgments are not mutation proof.
Opaque shell/MCP, missing diff observations, pending calls, and background work
make effect coverage partial. Proven mutation wins over incomplete coverage.
False requires a completed turn with complete observed coverage and no proven
change. The pure reducer accepts an explicit complete/unknown telemetry contract;
a completed zero-tool response is false only under that complete contract.
Live reports always supply unknown: normalized turn completion carries status,
error and checkpoint metadata, but no tool-telemetry completeness guarantee.
Bridge handshake and runtime launch capabilities describe supported operations,
grammar versions and steering, not exhaustive tool observations or retention.
Neither start/completion framing nor the presence of some normalized items proves
completeness. Unknown adapters, silent omissions, pruned events and unhandled
provider events therefore cannot become zero counts or proof of no change.
Live whole-turn and post-accept counts remain null, with unknown tools/effects
coverage. A retained successful file diff or exact acknowledgment can still
prove changedAnything true. A provider canary demonstrates observed items for
one run; it does not establish a completeness contract for live reports.
Adapter capability support that can establish exhaustive observation and retention
is deferred; until that contract exists, live coverage remains unknown.

The normalized root completion path records one server-owned
wake.turn-outcome.v1 system operation with metadata.origin set to settlement.
Only explicit settlement records snapshots, idempotently. Report reads never
write rows or notify the hub; there is no read or restart backfill.
Stored snapshots are immutable and describe
the observations available at first recording. Reports recompute from retained
events, so late items and acknowledgments can change a report without rewriting
the snapshot or any account-pool receipt. Reports read locally retained history
without hydrating cold history, because hydration can write data. Missing or
archived observations remain unknown; a missing snapshot does not establish
complete coverage.
If a turn's start has been pruned, the report still derives its retained outcome
but settlement cannot record a snapshot: appending a turn-scoped event requires a stored
start. Existing snapshots remain unchanged.

Malformed evidence degrades only its affected turn. Malformed request rows
degrade turns accepting that request; an undecodable first acceptance also
suppresses the request's first-turn claim. Undecodable critical identity or
completion evidence prevents settlement snapshots and completed counts for
affected turns. Valid effect proof survives malformed unrelated items.
Settlement diagnostics use finite error categories, never exception text or
row contents.

The response contains at most the newest 100 root turns and declares truncated
when older turns remain, with a nullable nextCursor. Rates describe completed
turns in the returned page only; empty
denominators are null. Turn discovery uses per-type equality queries that return
at most 101 grouped turn IDs each. Before applying cursor bounds or candidate
limits, each candidate must be its turn's earliest retained sequence across
all discovery types. Their bounded union sorts these global anchors descending
and selects 100 turns; a 101st distinct turn establishes truncation.
The opaque versioned cursor is bound to the thread and the last returned anchor.
Later events on old turns cannot move them onto newer pages or crowd out older
turns. Pruning can change retained anchors; paging is not a historical snapshot
across retention changes.
Nested turns with retained parent start evidence are excluded in SQL. Incomplete
turns and terminal turns without a start remain eligible. Completion snapshots
skip discovery and read only their exact target turn; their result is not a
thread-wide page and is not marked truncated for other turns.
Event payload reads are scoped by thread, selected turn and individual event
type, then merged by sequence.
Selected-turn reads explicitly use the existing thread/turn/type/item/sequence
index so all three equality constraints narrow the payload scan.
Request reads use only explicitly accepted IDs;
targeted earliest-acceptance lookups across history preserve original accepting
turns even outside the returned set. Discovery still scans indexed history, and
JSON request-ID lookups can scan the thread's matching event type with existing
indexes; neither loads unrelated historical payloads into JavaScript. Selected
turn event volume is not capped, preserving late and replay observations.
Reports contain
IDs, causes, counts, coverage, and effect kinds, never prompts, command strings,
tool arguments, file paths, diff contents, or credential values. Producers must
keep opaque wake references free of secrets.

Current task/card RPC caller context identifies only a client or plugin.
Outbound send context supplies a sender thread but no exact originating turn.
Neither path currently emits a turn acknowledgment: guessing the active turn
would misattribute concurrent or delayed work. Those shell/MCP calls remain
unknown. The internal acknowledgment writer is available for exact caller
contexts but has no task/card/outbound producer until that context exists.
No provider-specific hooks, wire changes, migrations, workspace hashes, or
receipt-format changes are part of this report.
