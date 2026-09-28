# Weaver migration plan

**Draft for mk’s approval. Implementation must not begin before approval and the required independent frontier review.**

**Review status (2026-09-28):** the required independent cross-lab review (`claude-opus-5-5`, `review-opus`, reviewing this Codex/Astra-authored draft) returned **send back for targeted rework** — 3 blockers, 8 major findings. See [weaver-migration-plan-review.md](weaver-migration-plan-review.md) for the full review. This draft has not been revised against those findings; it is preserved here as authored, alongside the review, pending mk's decision on how to proceed. Do not treat this document as approved or implementation-ready.

Weaver should make **Aleph tasks the single work tracker agents operate and mk sees**, eliminating independently maintained beads and board records. WEAV tracks this migration; `mk-gqds` remains its legacy hub reference.

The approximately 750 unowned cards, 77 stale beads, 922 MB `bb.db`, and September 28 slowdown are **reported observations from the brief**, not measurements reproduced here. This investigation inspected Aleph at `1c6f3c9a2f06ffda7775866e149385c39732c160`, Clavain at `081429eb5d05277d400010bbb27b358eb3dd0c27`, installed configuration, additional worktrees, and `bd` 1.1.2 help. Unrelated local changes were left untouched.

**Recommendation:** put generic tracker correctness in small, upstreamable changes to `plugins/tasks`; put migration, legacy compatibility, and mk-specific coordination in a fork-owned Weaver sibling plugin. All authoritative task state must remain in the Tasks database. A second authoritative sidecar would reproduce today’s problem.

The supplied `planning-astra` dispatch, `default` policy profile, `foundational-invariants` and `broad-consequences` classification, and `other-frontier` review requirement remain binding. The selected routing policy’s SHA256 was verified as `7209d67e29c4d9e668cb1ecd1d4d931600902cba4031fd35866b8b434b34f79b`. The recorded decision remains:

```json
{
  "reasons": ["foundational-invariants", "broad-consequences"],
  "rationale": "Changing tracker authority affects atomic claims, dependency readiness, identity, auditability, and coordination across mk's projects.",
  "investigation_active": true
}
```

## 1. Parity checklist against beads

For beads, the evidence below distinguishes **CLI promises** from tested implementation behavior. Help was executed from `/home/mk/hub`; its numbered output provides these references:

| Reference | Executed CLI evidence |
|---|---|
| B1 | `bd update --help`, line 17: atomic claim assigns the caller and sets `in_progress`; claiming again as the same actor is idempotent. Lines 13–38 expose notes, design, metadata, parent, labels, and external references. |
| B2 | `bd ready --help`, lines 1–15: blocker-aware ready work; excludes in-progress, blocked, deferred, and hooked issues; supports atomic `ready --claim`. Lines 33–40 cover label conjunction/disjunction and descendant filtering. |
| B3 | `bd dep add --help`, lines 8–21 and 35–40: dependency direction, external capabilities, cycle checking, and typed relationships. |
| B4 | `bd close --help`, lines 23–29: close reason, reason file, newly unblocked suggestions, and actor attribution. |
| B5 | `bd history --help`, lines 1–19: issue commit history and configurable Dolt auto-commit behavior. |
| B6 | `bd export --help`, lines 3–17: issue exports include labels, dependencies, and comments; exclude database history, branches, working sets, and non-issue tables. |
| B7 | `bd batch --help`: supported writes execute in one transaction, roll back together on error, and produce one Dolt commit. |

These are reproducible command-output references, not invented source-file citations. The installed beads implementation source was not located, and its live database was inaccessible in this sandbox.

| Capability | What Aleph tasks has today | Required change |
|---|---|---|
| **Atomic claim** | **Absent.** Task records have no owner, assignee, claim token, or revision field. Updates use `WHERE id = ?`, without an expected-version or ownership condition. Transactional updates alone do not implement compare-and-set claims. [Schema:27](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:27), [store:1088](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:1088). Compare B1. | Add transactional claim, release, handoff, and heartbeat operations; task revision; stable actor/session identity; claim generation/token; and explicit conflict results. Claiming must check eligibility and ownership in the same transaction. Same-owner retries must be idempotent. |
| **Dependencies, blockers, ready work** | **Absent as a task graph.** The schema contains parents, labels, comments, and task-thread links, but no dependency relation. List filters cover project, status, priority, labels, active threads, parent, and search; “active” means a starting/working attached thread, not readiness. [Schema:27](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:27), [contract:505](/home/mk/projects/Aleph/plugins/tasks/shared/contract.ts:505), [store:896](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:896). Compare B2–B3. | Add indexed, typed task relations, cycle rejection for blocking and parent edges, manual holds, deferral, and an explainable `ready` query. Support cross-project blockers within the workspace. Preserve distinct nonblocking relationships such as `tracks` and `related`. |
| **Nesting beyond one level** | **Absent through supported writes, but not prohibited by the SQL depth constraint.** SQL rejects only self-parenting. Both API and store reject a parent that is already a child and reject turning a task with children into a child. The API also requires the same project. [Schema:36](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:36), [API:209](/home/mk/projects/Aleph/plugins/tasks/api/index.ts:209), [store:741](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:741). | Replace depth restrictions with ancestor-cycle validation; add recursive ancestors/descendants and nested presentation. Keep parentage distinct from blocking. Preserve the complete imported hierarchy. The actual `mk-42j9` tree still needs live verification. |
| **Workspace and cross-project queries** | **Partially present already.** RPC `projectId` is optional, and SQL only applies a project restriction when provided. The CLI can list across projects without project context, but infers a linked tracker project inside a bb project. Duplicate label names across projects are ambiguous. [Contract:505](/home/mk/projects/Aleph/plugins/tasks/shared/contract.ts:505), [store:853](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:853), [CLI:301](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:301), [CLI:1378](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:1378). | Add explicit `--workspace`, multiple-project filters, immutable repository associations, campaign membership, and cross-project ready/blocked queries. Never depend on unsetting implicit thread context to obtain a workspace result. |
| **Actor attribution and audit history** | **Partial.** Comments retain kind, author name, optional thread, and timestamp. Task updates write system comments for status, priority, due-date, and label changes. That is more than timestamps, but not a complete structured audit: this path does not record title, description, or parent changes. CLI updates derive the author as `agent (<thread>)` or `cli`. [Schema:59](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:59), [API:719](/home/mk/projects/Aleph/plugins/tasks/api/index.ts:719), [CLI:601](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:601). Compare B5. | Add an append-only mutation journal with actor, authenticated origin where available, session/thread, operation ID, timestamp, prior/new revision, and changed values. Cover creation, deletion, ownership, hierarchy, dependencies, comments, and every mutation entry point. Preserve Dolt history separately. |
| **Close reasons, notes, labels** | **Labels and comments exist; dedicated close reason and notes fields do not.** Statuses include `done` and `canceled`; task fields contain a description but no beads-equivalent design, acceptance, notes, type, or general metadata fields. Labels are project-scoped. [Schema:27](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:27), [contract:117](/home/mk/projects/Aleph/plugins/tasks/shared/contract.ts:117). Compare B1 and B4. | Add structured resolution, close timestamp/actor, append-only notes, and versioned task metadata sufficient for current consumers. Preserve design, acceptance criteria, source type, full due/defer timestamps, external references, and operational state without burying them in title text. |
| **Agent CLI ergonomics** | **Useful CLI exists; parity commands do not.** Existing commands cover create/list/show/update/comment, delegation, attachment, threads, labels, projects, and folders, with JSON output. No claim, ready, or dependency commands are listed. Lists default to 100 and cap pages at 500. [README:59](/home/mk/projects/Aleph/plugins/tasks/README.md:59), [README:76](/home/mk/projects/Aleph/plugins/tasks/README.md:76), [pagination:1](/home/mk/projects/Aleph/plugins/tasks/shared/pagination.ts:1). | Add the proposed command surface below, stable JSON contracts, meaningful exit codes, batch operations, and persistent agent access. Preserve `bb tasks` as the command name. |
| **Offline/failure behavior** | **Server-dependent.** The CLI discovers plugin contributions, then POSTs the command to the server. Unreachable discovery emits `server_unreachable` and exits nonzero. No local Tasks write path appears in this flow. [CLI entry:48](/home/mk/projects/Aleph/apps/cli/src/index.ts:48), [proxy:378](/home/mk/projects/Aleph/apps/cli/src/plugin-cli-proxy.ts:378). **The current hub also depends on a server:** its metadata selects Dolt server mode, and auto-start is disabled. [Hub metadata:1](/home/mk/hub/.beads/metadata.json:1), [hub config:1](/home/mk/hub/.beads/config.yaml:1). | Fail closed for claims and mutations when authoritative service access fails. Offer explicitly stale read snapshots; never turn connection failure into an empty backlog or a successful write. Do not automatically fall back to beads after cutover. |

**Proposed CLI contract—not commands available today:**

```text
bb tasks ready --workspace --json
bb tasks ready --project AFTM --claim --actor <actor> --json
bb tasks update <key-or-legacy-id> --claim --actor <actor> --json
bb tasks dep add <task> <blocker> --type blocks --json
bb tasks blocked --workspace --explain --json
bb tasks close <task> --reason-file <file> --actor <actor> --json
bb tasks history <task> --json
bb tasks batch --file <operations.ndjson> --json
bb tasks agent serve --stdio
```

The implementation must preserve these invariants:

1. **One exclusive execution claim per task.** Accountable ownership and an execution claim are separate: an idle task still has an accountable person/coordinator or an explicit triage queue.
2. **All write paths enforce the same rules.** CLI, RPC, board moves, delegation, imports, and background services must enter a common mutation layer. Today delegation directly updates the store, so API-only enforcement would leave a bypass. [Delegation:346](/home/mk/projects/Aleph/plugins/tasks/delegate/index.ts:346).
3. **Lost contact does not mean released ownership.** Missed heartbeats create an attention state. Reassignment requires explicit revocation/handoff and a new claim generation. An expired heartbeat alone cannot prove the old worker stopped modifying a repository.
4. **Ready means eligible now.** It excludes active claims, terminal tasks, future deferrals, manual holds, unresolved blockers, and unresolved migration semantics. Claim rechecks readiness transactionally.
5. **No silent metadata loss.** Unsupported beads states, edge types, gates, or workflow records remain exceptions that block cutover for affected work.
6. **Errors remain distinguishable from empty results.** Preserve this distinction throughout every consumer.

## 2. Beyond parity

Aleph already has native connections that Weaver should strengthen rather than recreate.

**A task can carry its working context into a real worker thread.** Delegation selects a preset, spawns in the linked bb project, supplies description, subtasks, attachments, recent comments, and a report-back contract, then attaches the thread. Presets include provider, model, reasoning, permissions, environment, and optional service tier. [Delegation:97](/home/mk/projects/Aleph/plugins/tasks/delegate/index.ts:97), [delegation:304](/home/mk/projects/Aleph/plugins/tasks/delegate/index.ts:304), [README:106](/home/mk/projects/Aleph/plugins/tasks/README.md:106).

Extend this into a **claim-and-delegate workflow**:

- Reserve a claim and durable dispatch operation before spawning.
- Record the resolved routing policy and producer/reviewer role with the operation.
- Spawn through the approved execution path; a preset must not override required routing or independent review.
- Reconcile a crash between spawning and attaching. Do not blindly spawn again after an ambiguous response.
- Treat task completion, worker completion, and review acceptance as separate events.

**Comments already reach worker threads.** Current notification selects the latest agent commenter, sends with `steer-if-active`, and records a notified count. Failures are logged and return zero. This is useful, but the latest responder may be a reviewer or predecessor rather than the current owner. [Steering:25](/home/mk/projects/Aleph/plugins/tasks/steer/index.ts:25), [comment creation:415](/home/mk/projects/Aleph/plugins/tasks/api/index.ts:415).

Add an explicit recipient shown before sending: current responsible worker, latest responder, or selected attached thread. Store durable delivery status and retry identity. Distinguish “comment saved,” “delivery pending,” and “delivered.” Avoid promising exactly-once delivery unless the receiving thread API supports a proven deduplication key.

**Ownership should remain visible after failure.** Task-thread records currently support multiple attached threads; detaching removes a link, and lifecycle reconciliation updates thread status. Neither supplies an accountable task owner. [Schema:85](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:85), [detach:415](/home/mk/projects/Aleph/plugins/tasks/delegate/index.ts:415), [lifecycle:55](/home/mk/projects/Aleph/plugins/tasks/lifecycle/index.ts:55).

Add:

- “Needs owner,” “worker unreachable,” and “handoff pending” queues.
- An accountable owner on every nonterminal managed task, including explicit triage ownership.
- A handoff record preserving predecessor, successor, reason, and unfinished work.
- Workspace views of blocked work, unanswered operator comments, stale claims, and review obligations.
- A task dossier joining outcome evidence, dispatch receipts, repository/commit, and worker/reviewer threads.

These are proposed native product advantages. They are not claims that external integrations could never provide similar behavior around beads.

## 3. Load and performance

### What the code establishes

The Tasks database is **`<dataDir>/plugins/tasks/data.db`**, opened through `better-sqlite3` with WAL and a 5,000 ms busy timeout. It is separate from core `bb.db`, although plugin work runs through the server’s event-loop execution path. A separate database therefore does not establish process isolation. [Storage implementation:679](/home/mk/projects/Aleph/apps/server/src/services/plugins/plugin-api.ts:679), [SDK contract:179](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:179), [plugin runtime:782](/home/mk/projects/Aleph/apps/server/src/services/plugins/plugin-runtime.ts:782).

Several amplification paths deserve measurement:

- The Node CLI discovers plugin commands and submits each invocation over HTTP. [Entry:1](/home/mk/projects/Aleph/apps/cli/src/index.ts:1), [entry:48](/home/mk/projects/Aleph/apps/cli/src/index.ts:48), [proxy:400](/home/mk/projects/Aleph/apps/cli/src/plugin-cli-proxy.ts:400).
- Task listing loads labels across selected projects and performs a thread-list operation for every returned task. These are **server-side domain calls**, not one HTTP request per task: the CLI registers local handlers. [CLI:605](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:605), [CLI:670](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:670), [CLI:1428](/home/mk/projects/Aleph/plugins/tasks/cli/index.ts:1428).
- Lifecycle reconciliation enumerates tasks, then attached threads, then reconciles nonterminal threads. [Lifecycle:29](/home/mk/projects/Aleph/plugins/tasks/lifecycle/index.ts:29), [lifecycle:118](/home/mk/projects/Aleph/plugins/tasks/lifecycle/index.ts:118).
- One global task-list revision invalidates cursors after task, label, thread, or project-prefix mutations. Sustained writes can repeatedly invalidate a long traversal. [Schema:143](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:143), [store:978](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:978).
- Task activity fetches attachments separately for each nonsystem comment. [Activity:53](/home/mk/projects/Aleph/plugins/tasks/views/activity/task-activity.tsx:53).

These are plausible contributors, **not a diagnosis of the September 28 slowdown**.

### Recommended design

**First, reduce server work per operation.**

- Return a compact task projection containing labels, owner, readiness, blocker count, and active-worker count with bounded joined/aggregate queries.
- Query nonterminal task-thread rows directly; retain lifecycle events and use bounded reconciliation as recovery.
- Fetch activity and attachment metadata in pages.
- Scope UI invalidation to affected projects/tasks and coalesce notifications after batches.
- Add durable change-sequence reads and a stable export/snapshot mechanism. Keep ordinary UI cursor behavior explicit; migration must not depend on restarting an endlessly invalidated global cursor.
- Instrument query duration, transaction duration, queue delay, event-loop delay, event delivery lag, WAL growth, and request counts without logging sensitive content.

**Second, add bounded server-side batch operations.**

Start with a configurable maximum of **50 operations or 256 KiB per transaction**, then tune through experiments. Support:

- `atomic`: all operations commit or none do;
- `independent`: explicit per-operation outcomes, with no implication of all-or-nothing behavior;
- unique operation IDs and payload hashes;
- expected revisions and claim tokens;
- transactionally persisted results so a lost response can be retried safely;
- a post-commit outbox for notifications and dispatch work.

A repeated operation ID with a different payload is an error. Keep spawning, messaging, and external network work outside SQLite transactions.

**Third, amortize client startup.**

Provide `bb tasks agent serve --stdio` or an equivalent persistent SDK session. One process per coordinator accepts framed JSON requests, reuses authenticated connections, batches reads/heartbeats, and applies bounded concurrency. Agents able to use native plugin tools should use the same server operations through those tools.

This client is transport and an optional read cache. It does not own claims, calculate authoritative readiness offline, or become another database to reconcile.

**Fourth, protect interactive work.**

Use bounded admission queues, per-actor quotas, priority for small interactive/claim requests, and throttled import/background work. Start migration with one import writer. Pause imports when interactive latency or event-loop delay exceeds the agreed budget.

### Alternatives ruled out

| Alternative | Why it is not the initial design |
|---|---|
| Parallel shell loops spawning hundreds of `bb` processes | Adds startup, discovery, request, and notification overhead while still concentrating writes on the same server. |
| Agents opening Tasks SQLite directly | Bypasses authorization, audit, claim rules, migrations, and notification delivery. |
| Authoritative claims in a Weaver sidecar database | Cannot atomically coordinate ownership with Tasks state using the current per-plugin database boundary. |
| Treating a sibling plugin as process isolation | The inspected runtime does not establish that isolation. |
| One enormous import transaction | Risks blocking interactive work and creates an expensive recovery boundary. |
| Immediate replacement with another database service | Adds operational and upstream divergence before measuring whether bounded SQLite operations meet the workload. |

If the optimized implementation still misses acceptance budgets, stop rollout and evaluate a dedicated Tasks worker behind a typed asynchronous interface. That is a separately reviewed upstreamable architecture change, not an assumed existing extension point.

## 4. Upstream-merge hazard

`FORK.md` preserves bb package and command names and requires upstream merges rather than rebases. [FORK:7](/home/mk/projects/Aleph/FORK.md:7), [FORK:54](/home/mk/projects/Aleph/FORK.md:54).

Existing extension surfaces include per-plugin storage, HTTP routes, RPC contracts, CLI registration, background services, and agent instruction contributions. They do **not establish an existing Tasks transaction interceptor** that a sibling can use to enforce ownership across every Tasks write. [SDK storage:179](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:179), [HTTP/RPC:819](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:819), [CLI:1033](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:1033), [instructions:1657](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:1657).

| Planned change | Approach | Location and reason |
|---|---|---|
| Claims, revisions, actor attribution, complete mutation journal | **Upstreamable Tasks change** | `plugins/tasks/db/{schema,store}.ts`, `api/index.ts`, `shared/contract.ts`. These invariants must share the task transaction and benefit other multi-agent users. |
| Dependencies, ready/blocked queries, deeper nesting | **Upstreamable Tasks change** | Same domain/store files plus CLI and task views. Generic tracker capabilities; avoid maintaining a second graph beside the board. |
| Close reasons, notes, structured metadata, external aliases | **Upstreamable Tasks change** | Generic fields and contracts. Weaver-specific values live in a namespace; do not add a column for every Clavain concept. |
| Explicit workspace scope and repository/campaign filtering | **Upstreamable query primitives; fork-owned configuration** | Generic query support in Tasks; mk repository-to-board mapping and campaign policy in Weaver. |
| Batch API, idempotency, stable exports, durable change feed | **Upstreamable Tasks change using existing RPC/HTTP extension points** | Keep transaction ownership in Tasks. Do not construct “atomic batches” by chaining unrelated RPC calls. |
| List/activity enrichment, reconciliation, scoped refresh | **Upstreamable performance changes** | `cli/index.ts`, `api/index.ts`, `lifecycle/index.ts`, `shell/data.ts`, and activity views. Independently useful fixes with focused benchmarks. |
| Durable delegation/comment operations and visible delivery state | **Upstreamable Tasks change** | `delegate/index.ts`, `steer/index.ts`, activity UI, and a Tasks outbox. |
| Migration planner/importer, mapping review, checkpoints, rollback exporter | **Fork-owned sibling plugin** | Proposed `plugins/weaver/`. It calls supported Tasks operations and stores migration receipts, not authoritative copies of task state. |
| Clavain/CI adapters, lane policy, coordinator defaults | **Fork-owned integration code using extension points** | Keep policy in its owning repository; Weaver supplies task identity resolution and integration endpoints. |
| Persistent agent transport | **Upstreamable Tasks CLI/agent tool surface** | Preserve `bb tasks`; reuse plugin CLI and agent-tool registration. |
| Display name “Aleph tasks” | **Generic presentation override, fork-owned value** | Prefer a small upstreamable display-label setting, configured by Aleph. Current visible names are in `app.tsx:10`, package `bb.name`, and status text. [App:8](/home/mk/projects/Aleph/plugins/tasks/app.tsx:8), [package:28](/home/mk/projects/Aleph/plugins/tasks/package.json:28), [server:11](/home/mk/projects/Aleph/plugins/tasks/server.ts:11). |
| Dedicated worker, if experiments require it | **Separate upstreamable runtime change** | Requires another design review; not bundled speculatively into migration. |

**Naming boundary:** retain `bb-plugin-tasks`, `bb tasks`, plugin ID `tasks`, routes, table identifiers, task URIs, and internal symbols. Only presentation copy becomes **“Aleph tasks.”**

Keep each upstreamable capability independently reviewable and testable. Record carried patches and merge conflicts. Use additive migrations and compatibility tests so disabling Weaver does not require dropping task data.

If new public SDK surfaces prove necessary, follow Aleph’s `experimental_` naming and API-audit documentation requirements. [AGENTS:24](/home/mk/projects/Aleph/AGENTS.md:24).

## 5. Migration inventory

### Scope and evidence limits

The filesystem search covered canonical projects, hidden worktrees, installed Claude/Codex integrations, BB worktree instructions, hub configuration, systemd configuration, and deployed fleet files. A targeted instruction scan found **262 `AGENTS.md`/`CLAUDE.md` files** containing beads references; a separate filename scan found **526 beads primer/hook/script candidates**, including backups and cached copies. These are file counts, not counts of active integrations.

The inventory below groups copies by their canonical implementation. Historical transcripts, receipts, archived source, and old instruction backups must remain historical evidence. A filename match does not establish that a timer or hook is currently active.

### Clavain and agent coordination

| Confirmed files | Migration path |
|---|---|
| [`cmd/clavain-cli/exec.go:58`](/home/mk/projects/Clavain/cmd/clavain-cli/exec.go:58); callers in `claim.go`, `sprint.go`, `phase.go`, `goal.go`, `budget.go`, `complexity.go`, `children.go`, `daemon.go`, `watchdog.go`, `evidence.go`, `policy.go`, `review.go`, `runtime_evidence.go`, `factory_status.go`, `stats.go` | Introduce a typed tracker adapter with explicit backend/workspace/task identity. Port reads, state mutations, children, closure, and claims through it. Preserve existing `ic` run links and gate behavior. A missing backend must return unavailable, not success. |
| [`claim.go:195`](/home/mk/projects/Clavain/cmd/clavain-cli/claim.go:195); `hooks/bead-agent-bind.sh`; Interphase `bead-autoclaim.sh`, `heartbeat.sh`, `session-end-release.sh` | Replace advisory `claimed_by`/`claimed_at` label coordination with server CAS claims and ownership-checked heartbeat/release. Current Clavain comments explicitly say its advisory lock does not cover direct shell `bd` calls. Do not carry that gap forward. |
| [`scripts/dispatch.sh:321`](/home/mk/projects/Clavain/scripts/dispatch.sh:321), [`dispatch.sh:2895`](/home/mk/projects/Clavain/scripts/dispatch.sh:2895), [`config/evidence-manifest-schema.yaml:17`](/home/mk/projects/Clavain/config/evidence-manifest-schema.yaml:17), `config/cxdb-types.json` | Version receipt schemas to add canonical `task_ref`, backend, workspace, and optional legacy bead ID. Retain old fields/readers during transition and never rewrite signed/historical receipts. Port capacity-recheck filing through idempotent task creation. Preserve model routing and reviewer independence. |
| [`hooks/lib-discovery.sh:21`](/home/mk/projects/Clavain/hooks/lib-discovery.sh:21), [`hooks/lib-dispatch.sh:225`](/home/mk/projects/Clavain/hooks/lib-dispatch.sh:225), `hooks/lib-sprint.sh`, `hooks/lib-recovery.sh`, `skills/lane/SKILL.md` | Replace filesystem tracker discovery and per-bead dependency requests with workspace ready queries. Preserve lane IDs, paused lanes, phases, budgets, error classifications, and scoring inputs as structured metadata. |
| [`commands/next-goal.md:31`](/home/mk/projects/Clavain/commands/next-goal.md:31), [`scripts/next-goal-candidates.sh:23`](/home/mk/projects/Clavain/scripts/next-goal-candidates.sh:23), `scripts/next-goal-verify.sh` — **CLAV-68** | Add board-aware discovery that finds AFTM even without `.beads`. Preserve `ok`/`empty`/`unreachable`, provenance receipts, candidate freshness, lineage, and OUT-clause checks. Batch verification and resolve legacy IDs before ranking. |
| [`projects/.clavain-42j9-44/scripts/assemble-briefing.py:215`](/home/mk/projects/.clavain-42j9-44/scripts/assemble-briefing.py:215), [`:384`](/home/mk/projects/.clavain-42j9-44/scripts/assemble-briefing.py:384), [`commands/brief.md:24`](/home/mk/projects/.clavain-42j9-44/commands/brief.md:24) — **mk-42j9.44** | Coordinate with this worktree’s owner. Replace `bd_show`, children, dependencies, and ancestor reads with the tracker adapter. Replace text-search matching of bead IDs on boards with explicit alias lookup. Preserve source fingerprints, mandatory coverage, `NEXT`/`OPEN`/`DECIDED`/`EVIDENCE` parsing, and failed acceptance gates. This implementation was not present in main Clavain. |
| [`scripts/startup.py:227`](/home/mk/projects/Clavain/scripts/startup.py:227), `hooks/session-handoff.sh`, `session-end-handoff.sh`, `auto-stop-actions.sh`, `lib-signals.sh`, `gate-calibration-session-end.sh` | Replace direct JSONL reads and command-string inference with bounded task/event reads. Hand off canonical task IDs and explicit pending work. Do not auto-close work solely because a worker stopped. |
| [`scripts/beads-hygiene.sh:22`](/home/mk/projects/Clavain/scripts/beads-hygiene.sh:22), `bead-close-shipped.sh`, `bead-land.sh`, `gates/bead-close.sh`, `gates/bd-push-dolt.sh`, `backfill-decomposition-events.py`, `migrate-sprints-to-ic.sh`, `microrouter-deferral-status.sh` | Classify each as live maintenance, one-time migration, or historical utility. Port necessary live behavior; disable cleanup/sync writers at cutover; retain historical utilities with explicit archive-only operation. Preserve close/release gates. |
| `commands/{work,route,sprint,bead-sweep,campaign}.md`, `skills/project-onboard/`, [`templates/AGENTS.md.tmpl`](/home/mk/projects/Clavain/skills/project-onboard/templates/AGENTS.md.tmpl) | Update command instructions and project generation so new repositories receive the correct tracker binding. Compatibility wording must follow each project’s authority state. |

### CI, rig operations, transport, and backups

| Confirmed files | Migration path |
|---|---|
| [`/etc/zklw-ci/registry.json:2`](/etc/zklw-ci/registry.json:2), deployed `/usr/local/lib/zklw-ci/fleet.py`, [`/usr/local/bin/zklw-ci:1`](/usr/local/bin/zklw-ci:1), checkout `projects/ops-quilan-admit/ci/fleet/` | Add a canonical tracker reference alongside existing `campaign`/`task` aliases. Preserve immutable GitHub repository IDs, job IDs, source hashes, evidence, dispositions, and scheduling authority. Reuse existing migration tasks. Do not recreate the campaign or change CI execution architecture. |
| [`dotfiles/policies/independent-ci.md:10`](/home/mk/projects/dotfiles/policies/independent-ci.md:10), [`tools/sync-ci-policy.py:64`](/home/mk/projects/dotfiles/tools/sync-ci-policy.py:64) | After campaign cutover, update only tracker instructions and identity resolution. Keep independent zklw scheduling, two fresh-guest checks, canaries, signing, and publication gates. Synchronize this generated policy with the narrow script. |
| [`rig-health-check.sh:1499`](/home/mk/projects/dotfiles/common/.local/bin/rig-health-check.sh:1499), [`rig-file-drift-bead.sh:64`](/home/mk/projects/dotfiles/common/.local/bin/rig-file-drift-bead.sh:64), `estate-drift-check.sh`, `Sylveste/ops/canongraph/estate-drift-check.sh` | Replace list-then-create deduplication with idempotent task upsert keyed by finding fingerprint and repository ID. Preserve visible filing failures and bounded execution. |
| [`rig-autosync-freshness.py:79`](/home/mk/projects/dotfiles/common/.local/bin/rig-autosync-freshness.py:79), [`git-autosync-repair.sh:93`](/home/mk/projects/dotfiles/server/.local/bin/git-autosync-repair.sh:93), `rig-hook-integrity.py`; installed symlinks under `~/.local/bin` | Remove live `.beads/issues.jsonl` repair/export expectations only after cutover. Preserve ordinary Git autosync and hook-integrity checks. Edit canonical dotfiles targets, then verify installed links. |
| [`Sylveste/scripts/beads-auto-export.sh:2`](/home/mk/projects/Sylveste/scripts/beads-auto-export.sh:2), `beads-import-merged.sh`, `beads-sync-guard.sh`, `lib-beads-transport.sh`, `beads-binding-inventory.py`, `check_beads_jsonl_dolt_sync.py`, deletion/normalization helpers | Freeze authoritative transport per migrated tracker. Retain read-only archive verification and restore tooling. Prevent merges of old JSONL files from reopening writes to retired databases. |
| `.beads/{pull,push,heal-dolt,recover,close-and-sync}.sh`, `.beads/hooks/*`, Git hook dispatchers, [`cloud/pre-commit-beads-no-loss.py`](/home/mk/projects/dotfiles/cloud/pre-commit-beads-no-loss.py) | Inventory actual `core.hooksPath` and dispatcher composition. Remove only beads writer portions; preserve secret scanning, CI, and unrelated hooks. Keep archival no-loss checks where exports remain tracked. |
| [`ops/pg-backup/dolt-backup.sh:16`](/home/mk/projects/ops/pg-backup/dolt-backup.sh:16), [`zklw-backup-verify.sh:118`](/home/mk/projects/ops/pg-backup/zklw-backup-verify.sh:118), `~/.config/systemd/user/dolt-backup.service`, [`crontab.declared:51`](/home/mk/projects/dotfiles/server/.config/rig/crontab.declared:51), `ops-*/scripts/beads-health.sh` | Add consistent Aleph backups covering core DB, Tasks/Weaver databases, attachments, and configuration. Test restore. Retain Dolt archival backups; retire live database startup/repair only after consumer retirement. Reconcile outdated ports and paths rather than copying them. |

The installed registry contains **255 repository entries**, so migration scope must come from the registry, not the brief’s approximate repository count. It records Clavain as repository `1151593132`, task `mk-ag2s.25`; After Them as `848043458`, task `mk-ag2s.237`; and Aleph as `1382199355`, task `mk-ag2s.260`. [Clavain entry](/etc/zklw-ci/registry.json:811), [After Them entry](/etc/zklw-ci/registry.json:5892), [Aleph entry](/etc/zklw-ci/registry.json:6057). These are configuration observations, not successful live CI status checks.

### Additional consumers found

Paths in this table are under `/home/mk/projects/Sylveste/` unless otherwise stated. Corresponding `.codex` copies and installed plugin packages require controlled updates too.

| Consumer and evidence | Migration path |
|---|---|
| [`os/Remontoire/internal/adapters/beads.go:47`](/home/mk/projects/Sylveste/os/Remontoire/internal/adapters/beads.go:47), `internal/app/{app,config}.go` | Implement a Tasks adapter preserving promotion/experiment fingerprints, readiness, cycle IDs, and unavailable results. |
| [`os/Ockham/internal/discover/discover.go:24`](/home/mk/projects/Sylveste/os/Ockham/internal/discover/discover.go:24), `internal/inflight/inflight.go`, `cmd/ockham/{check,discover,dispatch}.go` | Replace workspace-path scans and inflight bead queries with explicit workspace/project queries and canonical claims. Preserve source-error reporting. |
| [`apps/Autarch/internal/mycroft/patrol/source.go:54`](/home/mk/projects/Sylveste/apps/Autarch/internal/mycroft/patrol/source.go:54), `internal/mycroft/briefing/briefing.go`, `pkg/fleet/aggregator.go`, `internal/door/product.go` | Port queue discovery, fleet aggregation, work instructions, and product reads through the common client. |
| `apps/Intercom/src/query-handlers.ts`, [`rust/intercom-core/src/demarch.rs:237`](/home/mk/projects/Sylveste/apps/Intercom/rust/intercom-core/src/demarch.rs:237), Go/Rust config and CLI allowlists | Replace allowed beads reads with explicit Tasks reads; keep mutation authority separate. Update examples and error handling. |
| [`interverse/interlab/internal/orchestration/beads.go:88`](/home/mk/projects/Sylveste/interverse/interlab/internal/orchestration/beads.go:88), orchestration `dispatch.go`, `plan.go`, `status.go`, `synthesize.go` | Port create/depend/claim/state/close together. Remove “missing tracker means successful claim” behavior for managed work. |
| [`interverse/interphase/hooks/lib-gates.sh:151`](/home/mk/projects/Sylveste/interverse/interphase/hooks/lib-gates.sh:151), `lib-phase.sh`, `lib-discovery.sh`, `scripts/bd-who` | Preserve gate evidence and phase semantics while replacing reads, notes, actor listing, and graph discovery. |
| [`interverse/interline/scripts/bd-lane-wrapper.sh:174`](/home/mk/projects/Sylveste/interverse/interline/scripts/bd-lane-wrapper.sh:174), `scripts/statusline.sh`; [`dotfiles/server/.bashrc:20`](/home/mk/projects/dotfiles/server/.bashrc:20) | Move lane defaults into explicit task creation context; replace shell interception and status queries. Validate lanes by ID, not guessed text. |
| [`core/intercore/internal/cost/baseline.go:330`](/home/mk/projects/Sylveste/core/intercore/internal/cost/baseline.go:330), `internal/lane/velocity.go`, `config/metrics.yaml`, `pkg/autonomy/ops.go`; Interstat `session-start.sh`, `set-bead-context.sh`, `cost-query.sh` | Version task references in metrics and authorization descriptions; preserve historical cost attribution and `ic` links. Replace closed-task/status inputs without rewriting old results. |
| [`interverse/interspect/scripts/signals/collect_bead_close.py:13`](/home/mk/projects/Sylveste/interverse/interspect/scripts/signals/collect_bead_close.py:13), `hooks/lib-interspect.sh`, `remeasure-skill-coverage.sh`; `intermix/internal/eval/bead.go` | Replace JSONL/CLI observations with journal events and stable task references. Maintain explicit source/version labels for historical evaluations. |
| [`interverse/interkasten/server/src/sync/beads-sync.ts:40`](/home/mk/projects/Sylveste/interverse/interkasten/server/src/sync/beads-sync.ts:40), `sync/engine.ts` | Replace the beads adapter; fence reverse-sync writes during cutover. Preserve existing external record identities. Fix failure-as-empty behavior before it can appear as mass deletion. |
| [`interverse/interop/internal/adapters/beads/adapter.go:21`](/home/mk/projects/Sylveste/interverse/interop/internal/adapters/beads/adapter.go:21) | Replace polling and inbound `bd create/update/close` with sequenced events and idempotent Tasks mutations. Preserve loop-prevention identity. |
| [`interverse/interject/src/interject/outputs.py:83`](/home/mk/projects/Sylveste/interverse/interject/src/interject/outputs.py:83), `awareness.py`, `feedback.py`; [`interseed/src/interseed/graduate.py:61`](/home/mk/projects/Sylveste/interverse/interseed/src/interseed/graduate.py:61), `context.py`; `interscout/scripts/urgency-check.sh` | Port discovery and task creation with durable source fingerprints, explicit project/owner, and idempotency. |
| [`projects/interflect/src/interflect/appliers.py:131`](/home/mk/projects/interflect/src/interflect/appliers.py:131), [`shadow-work/tools/sw-agent/lib/verbs/gap-import.js:75`](/home/mk/projects/shadow-work/tools/sw-agent/lib/verbs/gap-import.js:75) | Update generated task commands and import adapters; retain draft/approval and duplicate-detection behavior. |
| `interverse/interpath/scripts/{generate-module-roadmaps,sync-roadmap-json}.sh`, [`interwatch/scripts/interwatch-scan.py:203`](/home/mk/projects/Sylveste/interverse/interwatch/scripts/interwatch-scan.py:203), `interwatch-audit.py`, watchables, `lattice/src/lattice/connectors/beads.py` | Use typed aggregates/change feeds; preserve roadmap schema compatibility and distinguish unavailable data from zero activity. |
| `core/intermute/scripts/{check-file-conflict,session-status}.sh`, `intersynth/hooks/lib-verdict.sh`, `internext/scripts/top-skills.py`, `interlearn/hooks/session-end.sh` | Port task lookup, finding creation, and activity signals; retain independent file-reservation and review systems. |
| `Sylveste/scripts/{backlog-sweep,bd-create-checked,bd-show,bd-grep,audit-roadmap-beads,backfill-bead-labels}.sh` or `.py`; `projects/solwend/scripts/{audit,inventory}.sh`; Meadowsyn snapshot generators | Replace active reporting and maintenance; retire one-time migration helpers. Do not reproduce stale-task auto-closure without an explicit reviewed policy. |

### Instructions and coordinator habits

Confirmed instruction sources include:

- [`~/.claude/CLAUDE.md:18`](/home/mk/.claude/CLAUDE.md:18), [`~/projects/AGENTS.md:148`](/home/mk/projects/AGENTS.md:148), their dotfiles sources, and [`beads-PRIME.md:8`](/home/mk/projects/beads-PRIME.md:8).
- Claude hook wiring for export guarding, Dolt healing, and the primer. [Settings:126](/home/mk/.claude/settings.json:126), [primer:44](/home/mk/projects/dotfiles/common/.claude/hooks/bd-prime-once.sh:44).
- Kimi’s `bd-prime-inject.sh`, Codex skills/rules, Sylveste’s `.gemini/commands/clavain/`, Clavain project templates, and the 262 matching project/worktree instruction files.

For **each matched instruction file**, classify it as canonical active source, generated deployment, live worktree copy, or archive. Update active sources to describe explicit tracker/workspace identity, atomic claims, ready queries, outage behavior, and legacy-ID resolution. Regenerate deployed copies through their owning mechanism; preserve archived text.

For **each coordinator**, record actor ID, bb thread/session, project scope, current claims, loaded instruction version, and selected tracker backend. Replace the habit:

```text
cd /home/mk/hub
bd --actor <name> update <id> --claim
```

with the approved Tasks equivalent only when that scope changes authority. Fresh-session acceptance is mandatory: editing instruction files does not update an already running coordinator’s habits. The SDK likewise documents that changed instruction contributions do not replace a live provider session’s constructed instructions. [SDK:1657](/home/mk/projects/Aleph/packages/plugin-sdk/src/backend-contract.ts:1657).

**Inventory completion gate:** before retirement, every discovered consumer must have an owner and disposition: migrated, disabled, archive-only, or proven false positive. Repeat searches including installed symlink targets, selected plugin caches, worktrees, Git hook configuration, scheduler definitions, and active coordinator instructions. The current read-only investigation cannot certify which of all discovered copies are executing.

## 6. Rollout

### Stage 0 — Approve the design and capture the live baseline

Preserve WEAV/`mk-gqds` as the migration identity. Obtain independent other-frontier review using the actual author receipt’s producer identity, then mk’s approval.

Capture:

- Live board/project IDs and repository associations, especially AFTM, CLAV, and WEAV.
- Hub identity, status/type distributions, parents, all edge types, ownership, operational metadata, and references to other trackers.
- Full consumer disposition manifest from section 5.
- Installed versions, selected plugin paths, routing receipts, live CI status, and backup/restore evidence.
- Performance baseline under ordinary use and controlled bulk load.

**Authority:** beads remains authoritative for bead-backed execution claims, dependencies, and coordination. AFTM’s existing board backlog remains its existing backlog; do not copy it back wholesale into beads.

**Rollback:** none required for observation. No tracker authority changes.

### Stage 1 — Build parity and performance capabilities in isolation

Implement section 4’s changes in dependency order:

1. Mutation identity, revisions, audit, aliases, and idempotency.
2. Ownership/claims, dependencies, holds/deferral, nesting, and ready queries.
3. CLI/SDK/UI surfaces using the same mutation layer.
4. Batch/export/change-feed and persistent client.
5. Durable delegation/comment workflows.
6. Weaver import, comparison, adapter, and rollback tooling.

Append migrations to the existing Tasks migration sequence rather than rewriting shipped statements. Its current initialization applies versioned SQL transactionally. [Schema:244](/home/mk/projects/Aleph/plugins/tasks/db/schema.ts:244).

**Authority:** production remains unchanged.

**Rollback:** disable experimental surfaces and Weaver; retain additive schema/data. Use disposable test restores to validate backward-compatible code rollback. Do not treat dropping new tables as an acceptable production rollback.

### Stage 2 — Pilot on After Them / AFTM

Use existing AFTM cards and preserve their keys, comments, and attached threads.

Before acceptance:

- Reconcile a bounded pilot cohort to existing hub execution records; create an explicitly mapped execution record only where the pilot requires one and none exists.
- Keep beads authoritative for that cohort’s execution claims.
- Run Tasks readiness/claim decisions in shadow mode; shadow success must never launch work.
- Exercise real operator comments, worker attachment, report-back, review, and visible ownership.
- Execute destructive/race/failure experiments in an isolated copy.

**Pilot acceptance means:** all Stage 2 criteria in section 7 pass, no critical defects remain, the reverse migration drill succeeds, the responsible operator verifies the records, and mk explicitly accepts the pilot.

Only then pause new AFTM starts, reconcile the final delta, drain or hand off active claims, and switch the accepted AFTM scope to Tasks authority.

**Rollback:** before acceptance, stop shadowing; beads continues unchanged. After AFTM authority switches, freeze AFTM mutations/starts, export and reconcile post-switch events into a recovery Dolt copy, restore beads authority, and only then resume agents. Preserve AFTM content and stable board IDs.

### Stage 3 — Migrate Clavain and its consumers

Ship the common adapter, receipt compatibility, role briefing, next-goal, lane/claim lifecycle, and dependent consumers.

Use an explicit authority registry per scope: `beads`, `shadow`, or `tasks`. It must never select a backend merely because one service is unavailable. Nonpilot scopes continue to use beads until their import/cutover stage.

Run old/new read comparisons with the same task set. Switch installed instruction sources and start fresh coordinator sessions only after adapter checks pass.

**Rollback:** revert adapter selection for scopes still owned by beads. For Tasks-owned scopes, use the same freeze/reconcile/authority-switch procedure as Stage 2. Never point an old client at a stale beads copy and allow it to claim work.

### Stage 4 — Import open beads and cut over in waves

Use a full archival backup plus a pinned issue export. An issue JSONL export alone is insufficient to preserve Dolt history; B6 explicitly says so.

**Identity mapping:**

```text
(source tracker identity, legacy issue ID)
    -> immutable Tasks ULID
    -> current human-readable board key
```

The hub’s recorded tracker identity is `2ad5d731-a8fd-4ea1-9474-0fe428b6c6df`. [Metadata:7](/home/mk/hub/.beads/metadata.json:7).

- Keep legacy strings such as `mk-42j9.44` as unique external aliases, not Tasks primary keys. Tasks RPC IDs require ULIDs. [Contract:39](/home/mk/projects/Aleph/plugins/tasks/shared/contract.ts:39).
- Map existing board cards to their existing ULIDs; never manufacture duplicate AFTM cards.
- Assign new human keys in the appropriate project. WEAV is for migration work, not a destination for every imported issue.
- Bind receipts and relations to immutable ULIDs. Preserve old human keys as aliases across later prefix changes.
- Use explicit reviewed repository/board mappings. Do not infer project ownership from an `mk-*` prefix or a title alone.
- Keep parent subtrees intact in an appropriate project/campaign board. Cross-project campaign membership uses `tracks` relations and repository associations. Any conflict with already-existing board placement requires an explicit mapping decision before cutover.

**Import content:**

| Source | Destination |
|---|---|
| Open/in-progress work | Corresponding task state, preserving raw source status |
| Blocked/deferred/hooked/custom states | Explicit hold/defer/gate representation; unresolved states remain ineligible |
| Parent hierarchy and dependency edges | Validated graph with direction/type preserved |
| Labels | Project labels plus explicit mappings for lane/state conventions |
| Notes, design, acceptance, type, metadata, due/defer timestamps | Structured fields/namespaces with lossless source payload retained |
| Comments | Original author/time/content plus import provenance |
| Close reasons and closed referenced issues | Resolution data and linked terminal records/archive references |
| Worker/thread associations | Verified links; do not guess a thread from matching text |

Importing comments needs a dedicated path: current `createComment` stamps `nowIso()`, so ordinary comment creation would lose original timestamps. [Store:1371](/home/mk/projects/Aleph/plugins/tasks/db/store.ts:1371).

Import all nonterminal work plus the closed ancestors/blockers needed to preserve graph meaning. Retain the complete source archive. Keep memories and unrelated private records out of board imports; export options include them only when explicitly selected.

For each wave:

1. Dry-run and review mapping/conflicts.
2. Take a consistent baseline and record source fingerprints.
3. Import in resumable idempotent batches.
4. Freeze source mutations briefly; reconcile the final delta.
5. Compare counts, fields, comments, edges, readiness, and ownership.
6. Drain or explicitly hand off active claims.
7. Fence old writers; atomically change the scope’s authority record.
8. Resume only upgraded clients.

Migrate the CI campaign after simpler waves, preserving `mk-ag2s` and repository-task aliases throughout. Tracker migration must not reset CI migration dispositions or authorize workflow publication.

**Rollback:** freeze the affected scope, retain the imported tasks and event journal, reconstruct a writable recovery tracker from the immutable archive, replay every acknowledged post-cutover change, reconcile new tasks and aliases, then change authority back. If the delta is unavailable or lossy, remain paused rather than resume from stale state.

### Stage 5 — Retire beads as a live work tracker

Require all active consumer dispositions to be resolved and all accepted scopes to use Tasks.

- Disable beads writers, auto-import/export, claim hooks, and obsolete repair/start jobs.
- Keep a read-only archive containing full Dolt history, working-set capture, exports, configuration, mapping, checksums, CLI version, and restore instructions.
- Preserve legacy-ID lookup to migrated tasks or archive records.
- Keep archive backups and restore drills.
- Retain historical receipts and source documents unchanged.
- Observe at least one complete cycle of every scheduled consumer before declaring retirement.

**Rollback:** activate a tested recovery copy only through the freeze/reconcile procedure. The archive itself stays immutable. If the system cannot account for all acknowledged Tasks mutations, recovery remains blocked rather than silently losing work.

## 7. Acceptance criteria and experiments

All thresholds below are **proposed gates**, not achieved results.

| Stage | Required evidence before advancing |
|---|---|
| **0 — Baseline and approval** | Independent review receipt with correct producer separation and policy hash; mk approval; live tracker/board identities; classified consumer manifest; fresh CI status; successful isolated restoration of both tracker systems; reproducible performance baseline. |
| **1 — Correctness build** | Simultaneous claims by 100 distinct actors produce exactly one owner; same-operation retries return the original result; stale tokens cannot release or mutate a successor’s claim. Test CLI, RPC, UI move, delegation, import, and background paths. |
| **1 — Graph and data** | Deep hierarchy and reparent-cycle tests; cross-project blockers; manual holds and deferral; unsupported edge/state rejection; complete audit records; close/reopen reasons; atomic metadata updates. Differential ready-query tests against installed beads on representative fixtures. Every unexplained difference blocks parity acceptance. |
| **1 — Crash recovery** | Inject crashes before/after commit, after commit before response, before/after worker spawn, and before/after comment delivery. No lost acknowledged task writes, duplicate imported tasks, falsely successful claims, or unaccounted spawned workers. Ambiguous external effects remain visible for reconciliation. |
| **1 — Compatibility** | Existing Tasks tests remain green; old supported clients receive compatible responses or explicit unsupported-version errors. Schema rollback is demonstrated on copies. No plugin/package/command/internal-ID rename. |
| **1 — Performance** | Representative restored data, then 10× observed task/event volume. Exercise at least 100 agent clients, 100 reads/s and 10 writes/s for an hour, burst contention, concurrent import, and a 24-hour ordinary-load soak. Measure core bb interaction alongside tracker operations. |
| **2 — AFTM pilot** | At least five working days and 20 real task journeys, including operator comment → intended worker → reply → review. No duplicate cards, lost comments, incorrect recipients, invisible owner loss, or unexplained shadow readiness differences. Test coordinator restart and thread failure. mk confirms the board is sufficient for daily tracking. |
| **2 — Acceptance/cutover** | Evidence bundle names the exact pilot scope, versions, remaining noncritical defects, rollback drill, and explicit mk acceptance. Final claim handoff has no overlapping authoritative execution. |
| **3 — Clavain migration** | Fresh Claude and Codex coordinator sessions find AFTM without `.beads`; next-goal retains unavailable/empty distinctions; two coordinators cannot acquire the same claim; role briefing preserves source coverage and unknowns; lane/state/phase/budget workflows work; old and new receipts remain readable with unchanged routing/review gates. |
| **4 — Import and waves** | Every source issue has one mapping or a reviewed exclusion; no duplicate aliases; all required edges and comments reconcile; source timestamps and metadata survive; no unsupported active state is treated as ready. Re-running and interrupting import causes no duplication. Cross-project campaign queries include the complete registry-defined scope. |
| **4 — Rollback** | Reverse replay reconstructs all acknowledged changes, including newly created tasks, comments, reassignment, closure, and metadata. Compare normalized records and graph hashes before reopening claims. |
| **5 — Retirement** | No active beads writer remains; every scheduled consumer has completed its normal cycle; fresh sessions issue Tasks commands; archive lookup and full restore work; backup freshness is verified; no unknown consumer is dismissed solely because it produced no recent writes. |

**Initial performance budgets:**

- Warm ready/list requests: p95 ≤250 ms.
- Claims and small mutations: p95 ≤500 ms, including queue time.
- Event-loop delay: p99 ≤100 ms under the qualification workload.
- Interactive bb latency: no more than 20% regression against the same baseline workload.
- Zero lost acknowledged operations and zero duplicate exclusive claims.
- Import pauses automatically when budgets are breached.
- Target short transactions, initially ≤25 ms p99; reduce batch size if necessary.

Measure cold CLI startup separately from warm persistent-client requests. A persistent client is successful only if it reduces actual process/request overhead without moving authority into its cache.

Use real SQLite-backed tests. Aleph requires Turbo orchestration, and the Tasks package is named `bb-plugin-tasks`; its scripts include test, lint, typecheck, and build. [AGENTS:31](/home/mk/projects/Aleph/AGENTS.md:31), [AGENTS:44](/home/mk/projects/Aleph/AGENTS.md:44), [package:43](/home/mk/projects/Aleph/plugins/tasks/package.json:43). The initial verification command is:

```sh
pnpm exec turbo run test typecheck lint build --filter=bb-plugin-tasks
```

Add affected SDK, CLI, server, Weaver, and consumer checks as those components change. Independent zklw automation remains mandatory. Any transferred workflow class still needs two successful executions at the same commit in fresh isolated guests and applicable real canaries. [CI policy:29](/home/mk/projects/dotfiles/policies/independent-ci.md:29).

Escalate immediately if an experiment disproves the architecture’s consistency or performance premise. Preserve failed evidence; do not redefine readiness, ownership, or verification to obtain a passing result.

## Open questions and unresolved risks

1. **Live state was inaccessible.** Hub access failed with a socket permission error; bb returned `server_unreachable` with `EPERM`; `zklw-ci status` failed at its sudo wrapper under `no_new_privs`. These are sandbox/infrastructure restrictions, not evidence that the services are down. No restriction was bypassed.
2. **The supplied counts need measurement.** Unowned/stale counts, database size, incident workload, and the actual slowdown cause remain unverified.
3. **Repository naming has drifted.** `FORK.md` names `mistakeknot/bb`, while Git origin and the deployed registry identify `mistakeknot/aleph`, repository ID `1382199355`. Resolve documentation and live identity before CI changes.
4. **Actual beads graph semantics need differential testing.** The `mk-42j9` depth, active dependency types, gates, custom states, and closed-history completeness could not be checked against the live hub.
5. **Existing board reconciliation is unresolved.** AFTM/CLAV/WEAV IDs, duplicates, owner identities, and repository mappings require live reads and operator review. Text matches cannot settle identity.
6. **Consumer activation is not fully known.** Source searches identified the families above, but active timers, remote Mac adapters, loaded coordinator instructions, and all installed cache selections need deployment inventory. Retirement is blocked until each has a disposition.
7. **Upstream acceptance is unknown.** The plan identifies upstreamable changes; it does not assume upstream will accept them. Reassess carrying cost if the generic correctness changes are rejected.
8. **External-effect deduplication needs proof.** Worker spawning and thread messaging cross the Tasks transaction boundary. Their retry contracts must be verified before claiming automatic crash recovery.
9. **Independent review remains outstanding.** This is the frontier author’s plan, not a completed independent review. Preserve the supplied policy and use the actual producer receipt for the other-frontier review before implementation approval.
10. **No plan file or tracker state was written.** This session is read-only; the document is delivered here for review.