---
kind: instruction
title: bb Guide — Thread messaging
summary: Command reference for thread messages, ownership, interactions, and queued messages.
intent: Document how agents talk to threads and manage their queues.
editingNotes: Keep flags accurate against the CLI implementation. Run the json-flag-enforcement and command-output tests after changes.
---
Thread messaging

Messaging commands require an explicit thread ID or --self.

Messaging:

  bb thread tell <id> <message>            Send a follow-up message
  bb thread tell <id> --message-file <path>
                                           Read the message from a file; `-` reads stdin. Use this for
                                           multi-line or Markdown messages: inside double quotes the
                                           shell runs `backticks` and $(...) before bb sees them
    --mode <mode>                          Message mode: steer (default), queue, or auto
    --model <model>                        Model override for this turn
    --reasoning-level <level>              Reasoning level override
    --plan                                 Send the message as the provider's /plan action
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --compact-first                        Compact the idle thread's context, then send when compaction finishes
    --file <path>                          CLI-local absolute path, file: URL, or uploaded file path
    --image <path>                         CLI-local absolute path, file: URL, or uploaded image path

  Tell steers by default, delivering the message immediately into the active
  turn. Use --mode queue for non-urgent follow-ups that can wait until the agent
  is free; --mode auto steers a live turn and starts a new one on an idle
  thread. Input sent while a turn is starting stays in the queue with
  `waitingOn: turn-starting`; `turn/started` wakes it and steers it into that
  turn. A target that is awaiting user interaction (an open question or
  approval) cannot take a prompt; tell then adds the message to the thread's
  queue and dispatches it once the interaction settles. That outcome is not a
  failure, so do not resend. `--json` reports `delivery` as `sent` or `queued`,
  and a queued answer carries the complete row as `queuedMessage`, including
  its `id`, `waitingOn`, and `sendAt`. A deferred message waits for a thread
  that failed while it was deferred, and delivers when the thread is retried.

  --plan sends the same structured /plan command the composer's plan action
  sends, so the agent proposes a plan for approval before executing (Claude
  Code and Codex threads). Plain "/plan ..." text is not recognized; it reaches
  the provider as literal text. Approve or deny the proposed plan with
  `bb thread interactions`; `bb thread cancel-plan` leaves Plan mode early.
  SDK callers build the same input with
  `createBuiltinPlanCommandTextInput(text)` from `@bb/sdk` and pass it as
  `input` to `threads.spawn` or `threads.send`.

Ownership:

  bb thread update [id]                    Update thread metadata
    --self                                 Target current thread
    --title <title>                        Set title
    --parent-thread <id>                   Assign to a parent thread
    --clear-parent-thread                  Remove parent assignment
    --section <id>                         Move into a section
    --clear-section                        Remove section assignment
    --if-section <id|none>                 Require the current section (none means no section)
    --if-unpinned                          Require an unpinned thread
    --if-unarchived                        Require an unarchived thread
    --if-top-level                         Require a thread with no parent
    --model <model>                        Set the sticky model for the next and later turns
    --reasoning-level <level>              Set the sticky reasoning level (provider-dependent)
    --visibility <visibility>              Set visible or hidden
    --parent-notifications <value>         Set auto, stuck, or off (applies to later outcomes)

  Clearing a parent inherits the former parent's section unless --section or
  --clear-section is also supplied. Children released by environment archiving
  also inherit their former parent's section.

  Section preconditions require --section or --clear-section and cannot be
  combined with title, parent, model, reasoning, or visibility updates. A
  mismatch leaves the thread unchanged, prints its current state, and exits
  nonzero. For example:

    bb thread update T --section S2 --if-section S1 --if-unpinned --if-unarchived --if-top-level

  SDK callers use threads.update({ threadId: "T", sectionId: "S2",
  ifSectionId: "S1", ifUnpinned: true, ifUnarchived: true, ifTopLevel: true }).
  ifSectionId: null requires no section; sectionId: null clears the section.

  Model and reasoning updates stay within the thread's current provider. BB
  validates them against that provider's current model catalog, applies them on
  the next turn, and keeps using them on later turns until changed.

  bb thread read [id]                      Mark read
  bb thread unread [id]                    Mark unread
  bb thread reorder-pinned <id> [--after <id>] [--before <id>]
    --if-sort-keys <thread,previous,next>    Require the three current sort keys
  bb thread pin [id] [--self] [--if-unpinned]
  bb thread unpin [id] [--self] [--if-pinned-at <ms>]

  Pin preconditions preserve manual changes: --if-unpinned requires no pin;
  --if-pinned-at requires the observed non-negative integer pin timestamp.
  --if-sort-keys takes exactly three comma-separated keys; none means null
  for previous or next, and the thread's own key cannot be none. For example:

    bb thread pin T --if-unpinned
    bb thread unpin T --if-pinned-at 123
    bb thread reorder-pinned T --before T2 --if-sort-keys a0,none,a2

  SDK equivalents are threads.pin({ threadId: "T", ifUnpinned: true }),
  threads.unpin({ threadId: "T", ifPinnedAt: 123 }), and
  threads.reorderPinned({ threadId: "T", previousThreadId: null,
  nextThreadId: "T2", ifSortKeys: { thread: "a0", previous: null, next: "a2" } }).
  A mismatch returns HTTP 409 conflict with details.current; the CLI prints
  Current state: followed by that JSON and exits nonzero. Omit preconditions
  for the existing unconditional behavior, including idempotent pin/unpin.

Interactions:

  bb thread interactions list [id]         List a thread's pending and past interactions
  bb thread interactions show <interaction-id> [id]
                                           Show one interaction (approval details, questions, or a plugin form's data)
  bb thread interactions approve <interaction-id> [id]
                                           Allow a command, file-change, plan, or tool-use approval
  bb thread interactions deny <interaction-id> [id]
                                           Deny an approval
  bb thread interactions grant <interaction-id> [id] --scope turn|session
                                           Grant a permission interaction
  bb thread interactions answer <interaction-id> [id] --choice <questionId=value> --text <questionId=text>
                                           Answer a provider's user question
  bb thread interactions respond <interaction-id> [id] --value '<json>'
                                           Answer a plugin form: a plugin's own request, or a request the agent raised through a provider (kind `<pluginId>/<name>`)
    --self                                 Target current thread (every subcommand)
    --json                                 Machine-readable output (every subcommand)

  `show` prints a plugin form's `Data` so you can shape the `--value` JSON.
  A provider's plugin-defined request cannot be cancelled; stop the thread to
  back out of it.

Queued messages:

  bb thread queue list [<thread-id>] [--wait-holder plugin:<plugin-id>]
  bb thread queue create <thread-id> <message> [--file <path>] [--image <path>]
  bb thread queue update <thread-id> <message-id> <message> [--file <path>] [--image <path>]
                                           create and update also take --message-file <path>
  bb thread queue send <thread-id> <message-id> [--mode auto|steer]
  bb thread queue transfer <thread-id> <message-id> <target-thread-id>
  bb thread queue transfer-all <thread-id> <target-thread-id>
  bb thread queue reorder <thread-id> <message-id> [--after <id>] [--before <id>]
  bb thread queue group <thread-id> <boundary-id> --prefix <comma-separated-ids>
  bb thread queue delete <thread-id> <message-id>

  The `Sender` column identifies agent threads and system notices; user messages
  leave it blank. The SDK and `--json` include `initiator` and `senderThreadId`.
  SDK: `threads.queue.list` (all threads) and
  `threads.queuedMessages.list|send|update|delete` (one thread).

  `transfer` moves one unclaimed queued row to another thread in the same
  project in a single transaction, keeping its system-notice classification,
  `sendAt` and plugin or time wait (thread-bound waits are re-derived for the
  target). SDK: `threads.queuedMessages.transfer`. A row a drain has claimed is
  refused with 409; a retry row, or any non-inline payload, is refused with 400
  because it names a turn request that exists only on its own thread. A held
  system notice's content cannot be edited (409) and its queue read reports
  `editable: false`. Transfer is the only way to preserve that metadata: create
  strips `systemNotice`, `waitingOn` and `sendAt`. A plugin that must park rows
  (compact, fresh start, abort, retirement) should transfer the original rows
  out and back, not delete and recreate them.

  `transfer-all` is the bulk form (SDK `threads.queuedMessages.transferAll`,
  `POST /threads/:id/queued-messages/transfer-all {targetThreadId}`): one
  transaction moves every unclaimed inline row to the target in source order,
  with the same preservation and refusals (same project; target not archived or
  missing). Claimed rows and retry rows stay on the source and are reported in
  `skipped` with reason `claimed` or `not_inline`; `moved` maps each old id to
  its new id. A source with more than 1000 queued rows (claimed and retry rows
  included) is refused with 409 `thread_not_writable`, reason
  `source_queue_too_large`, and nothing moves; send or delete rows and retry, or
  move them one at a time. Group edges are not carried. It is idempotent: a
  repeat call after success moves nothing, so a caller that lost the response
  can call again and reconcile from the lists. Use it to forward a retiring
  thread's pending rows to its successor.

  A queued message is one that could not dispatch yet. It is not in the
  timeline or `thread log` until it dispatches; thread list rows carry
  `queuedWork: none|waiting|failed`. Every one carries a typed reason in its
  `Waiting on` column (`waitingOn.kind` in JSON: `thread-busy`,
  `turn-starting`, `provisioning`, `host-offline`, `interaction`, `time` for
  `Send at`, or `plugin` with `pluginId` and a reason). `queue list` with no thread id lists every
  queued row in the workspace; `--wait-holder plugin:<plugin-id>` narrows it to
  the rows one plugin is holding.

  The `State` column (`state` in the SDK and `--json`) is one of `queued` (next
  behind the running turn), `scheduled` (goes at `Send at`), `waiting` (held by
  its typed reason), `failed_retrying` (an automatic retry is booked),
  `failed_exhausted` (retries spent; waits for you), or `claimed` (a dispatch
  attempt is sending it).

  Failed rows show their failure reason instead of their previous wait, followed
  by a recovery command: `bb thread queue send <thread-id> <message-id>`.
  Use it to retry immediately, including after automatic retries are exhausted.
  Editing the message does not clear its failure or trigger a retry.

  `queue send` dispatches a row now, bypassing every plugin wait and its own
  schedule — the invariants (a running turn, an unfinished workspace, an
  unanswered interaction) still apply, and a message that hits one simply queues
  again. `--mode steer` uses those same send-now bypasses and re-attempts the row
  as a steer; it does not bypass the invariants, so a provisioning row remains
  queued until the workspace is ready.
  `queue delete` discards it instead. Both are always permitted.

  --compact-first runs the same /compact turn as `bb thread compact` and queues
  the message behind it, so it needs an idle or errored thread whose provider
  supports manual compaction; it cannot be combined with --send-at. The SDK
  takes `compactFirst: true` on `threads.send`, which also rejects
  `mode: "steer"`.

  --send-at takes an ISO 8601 timestamp (2026-08-25T09:00, local without an
  offset) or a duration from now (30s, 10m, 2h, 7d). A time that has already
  passed is rejected, as is a bare date, which has no time of day. Several
  queued rows on one thread are normal: two scheduled sends coexist. A
  scheduled spawn creates a `pending` thread and does no environment work (no
  worktree, no setup script) until it is due. The SDK takes `sendAt` in epoch
  milliseconds on `threads.spawn` and `threads.send`.

Application links in messages:

  Use an explicit Markdown link such as `[Review note](reflect://note/Project%20X)`
  or `[Open issue](linear://issue/ABC-123)`. The receiving user clicks the link
  to open it on their viewing device; sending or rendering a message never
  launches an application. Bare custom-scheme text is not auto-linked.

  Enable with `bb settings experiment applicationLinks true` or Settings →
  Experiments → Application links. BB asks before launching unless the user
  chose Always allow for that scheme on this BB site and device. Settings →
  General → Application link approvals can revoke saved choices. Executable
  web schemes and reserved editor-action
  schemes remain blocked. Existing editor file links keep their file-opening
  behavior. Desktop and native mobile clients need application-link support
  (mobile bridge version 3); older clients show an update message. Web browsers
  handle their own OS handoff and cannot reliably report missing applications.
