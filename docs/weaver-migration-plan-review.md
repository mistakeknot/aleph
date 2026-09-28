# Weaver plan: independent other-frontier review

Reviews [weaver-migration-plan.md](weaver-migration-plan.md) as authored (Codex/Astra, `planning-astra`). Hub tracking: `mk-gqds.1`. Escalated to mk via the vizier on 2026-09-28 for a decision on rework vs. scope change; not yet actioned against the plan.

**Reviewer:** claude-opus-5-5, effort high, profile `review-opus`. Producer receipt: `codex:gpt-6-astra`. Relationship: different model, other frontier. Policy hash `7209d67e…b79b`.

## Verdict: send back for targeted rework

The parity analysis (§1), the load analysis (§3) and the citation work are strong. I checked all 111 file:line citations: each path exists and each line is in range. About 30 of them I read for content, and none of those was wrong. Three things block approval:

- The plan says nothing about an explicit Clavain canon decision that contradicts it.
- It treats one hub as the migration source when about 57 beads trackers exist.
- Its migration waves rely on a "fence old writers" step for which beads has no mechanism.

§4 (upstream split) and §6 (rollbacks) also need rework before this foundational work is approved.

## Findings

**1. Blocker. The plan ignores Clavain's recorded decision that beads owns issue tracking.**
- **What I found:** the quote is real, at **line 18** (not 17): `| Issue tracking | Beads; BB Tasks is not a second tracker |`. It is not only in the `.clavain-coordburn` worktree. It is also in main Clavain at `081429eb`, which is the exact commit the plan says it inspected.
- **Who decided it:** mk, on 2026-09-22 (`e8059a6`, "define BB ownership contract…", sylveste-8252.5). It is still current.
- **More conflict in the same doc:** line 77 says every seat has an Intercore mapping keyed by bead, run, dispatch, attempt and thread.
- **What the plan does with it:** nothing. It doesn't address it, supersede it, or list the file among the §5 consumers.
- **Fix:**
  - Stage 0 needs an explicit mk decision that supersedes this ownership row, with the rationale recorded.
  - A reviewed canon change should land in Clavain before Stage 3.
  - `docs/canon/bb-integration.md` and the Intercore bead mapping belong in the §5 inventory.

**2. Blocker. The plan assumes one source tracker (§5, §6 Stage 4 and 5).**
- **What the plan assumes:** the identity mapping and import are built around the hub, `2ad5d731-…`. Other trackers show up only as "references to other trackers" in the Stage 0 capture list.
- **What exists:** under `~/projects` (maxdepth 3) I found **66 `.beads/metadata.json` files with 57 distinct `project_id`s**, in both server and embedded Dolt modes (ops, agmodb, Nartopo, auraken, …). 13 were modified this month.
- **Why it matters:** `lib-discovery.sh` and `startup.py` read these per-repo trackers today. Stage 5 would either strand them or leave them running as writers after beads is "retired".
- **Fix:**
  - Make a Stage 0 inventory of every tracker identity, whether it is live, and its disposition.
  - Add per-tracker scopes to the authority registry.
  - Add a Stage 4/5 criterion that every tracker is migrated, frozen, or archived.

**3. Blocker. Stage 4's "fence old writers; atomically change authority" has no mechanism.**
- **Why beads can't fence itself:** bd has no per-scope write control. The plan cites Clavain's own admission (`claim.go:195`) that the advisory lock doesn't cover shell `bd`.
- **Why old writers will keep writing:** the plan itself says 262 instruction files, and running coordinators, keep their old habits.
- **Result:** during the waves, stale sessions will run `bd update --claim` on migrated IDs while new sessions claim in Tasks. That is a split-brain state with duplicate execution and lost updates.
- **"Atomically" is not achievable here:** authority would span hub Dolt, a registry, and Tasks' `data.db`.
- **Fix:** pick one of these.
  - A server-side fence in Dolt, such as triggers that reject mutations to issues, deps or comments for migrated scopes, or revoking agent write grants.
  - Cut over write authority hub-wide in one step, and migrate only reads in waves.
- Also add a gate metric: **zero Dolt commits touching migrated IDs after the fence**, audited continuously.

**4. Major. The Weaver sibling plugin contradicts §3's own finding (§4 table, "Migration planner/importer").**
- **What the runtime provides:** each plugin gets its own `<dataDir>/plugins/<id>/data.db` (`plugin-api.ts:689`). The PluginApi surface (`backend-contract.ts:2053–2117`) has no call from one plugin into another.
- **What the plan leaves open:** it never says how Weaver "calls supported Tasks operations". The realistic mechanism is loopback HTTP into the same server.
- **Consequences of that mechanism:**
  - Import parsing and mapping run on the same event loop that §3 wants to protect.
  - Weaver's receipts can't commit in the same transaction as the Tasks writes they describe.
  - Nothing says where the per-scope authority registry (Stage 3) lives. If it lives in Weaver or anywhere outside Tasks, invariant 2 ("all write paths enforce the same rules") can't hold.
- **Fix:**
  - Run the importer as an **external process** using the batch API, with operation IDs persisted inside Tasks.
  - Put scope write authority and freeze state inside the Tasks mutation layer, as a generic "read-only scope" primitive that could go upstream.
  - Limit Weaver to UI and configuration, if it exists at all.

**5. Major. §4 misses that upstream just made Tasks forkable, and its "upstreamable" labels are optimistic.**
- **What upstream did:** `b7e34aa54` "Make the tasks plugin forkable (#4192)", 2026-09-23. `scripts/forkable-plugins.json:35` lists `plugins/tasks`, and `check-plugin-forks.mjs` exists.
- **What the plan misses:** it never weighs forking Tasks against carrying in-place patches, even though PHILOSOPHY §10 says "prefer a plugin or setting to a core edit."
- **Where upstream would plausibly say no:**
  - Claims with heartbeat and handoff semantics.
  - Cross-project blockers.
  - An append-only mutation journal.
  - Deep nesting. The one-level limit is deliberate: `store.ts:756` throws "Tasks support at most one level of sub-tasks".
- **Why this matters now:** these are feature PRs, and get-bb/bb requires maintainer sign-off on the issue *before* a feature PR. Open question 7 only reassesses after the work is built.
- **Fix:**
  - Before Stage 1, file upstream issues and get sign-off or a decline.
  - Then choose in-place carry, a fork of Tasks, or a sibling, using a written carrying-cost estimate. Tasks saw 20 upstream commits in 30 days.
  - The reverse case: the display-label setting and the §3 performance fixes are rightly upstreamable.

**6. Major. Positional migrations make "append to the existing sequence" unsafe in a fork (Stage 1).**
- **Why:** `schema.ts:257–260` computes `version = index + 1`.
- **What breaks:** if the fork appends migration N+1 and upstream later appends its own N+1, the merge collides. A database that already recorded the fork's N+1 would **silently skip** upstream's migration.
- **Fix:** namespace the fork's migrations with their own version key or table, or upstream named migrations first.

**7. Major. Claim identity is self-asserted, and coordinator rotation breaks it (§1 invariants, CLI contract).**
- **The actor problem:** `--actor <actor>` is a client string. If "same-owner retries are idempotent" is keyed on the actor, two sessions using the same name both "hold" the claim.
- **The thread problem:** the thread context also comes from the client's environment (`plugin-cli-proxy.ts:398`).
- **The rotation problem:** coordinators rotate with `bb handoff --replace` at about 100k tokens (bb-integration.md:24–51), and each rotation creates a new thread ID. Claims keyed to threads would be orphaned into "attention" queues on every rotation.
- **Fix:**
  - Key idempotency only on claim token or operation ID.
  - Add an explicit claim transfer to the `--replace` handoff path.
  - Add a Stage 1 test that rotates a coordinator while it holds a claim.

**8. Major. Stage 2 shadow mode leaves an existing launch path ungated.**
- **The path:** delegation on a card spawns a worker, then attaches it (`delegate/index.ts:330–352`), with no check against beads claims.
- **The gap:** "shadow success must never launch work" doesn't cover this. An operator or agent can delegate a cohort card while another agent holds its beads claim.
- **Fix:** for cohort cards, either check the beads claim before delegating or disable delegation. Measure cross-system double claims and require zero.

**9. Major. Rollbacks for Stages 2–4 skip the hard parts (§6).**
- **No reverse mapping for Tasks-only data:** "Export and reconcile post-switch events into a recovery Dolt copy" has nothing to translate:
  - claim generations
  - holds
  - handoff records
  - new relation types
  - natively created tasks without a legacy ID (which need new bd IDs, which then breaks aliases)
  - receipts that carry `task_ref`s for tasks created after cutover
- **Coordinators aren't reverted:** rollback doesn't revert instructions or restart coordinators. The plan itself says fresh sessions are needed. After authority flips back, coordinators migrated in Stage 3 would keep writing to Tasks.
- **Stage 4 is effectively one-way:** it says "remain paused if lossy". That is honest, but it means the stage may have no rollback, and the plan should say so and gate the stage on it.
- **Fix:**
  - Deliver the reverse mapping in Stage 1, with a table of what is lossy.
  - Rollback must include a Tasks-side scope freeze, reverting instructions, and restarting sessions.
  - The Stage 2 drill should exercise the whole procedure and measure how long the freeze lasts.

**10. Major. "Production remains unchanged" in Stage 1 is false.**
- **Why:** shipping these migrations in an Aleph release runs them against the production Tasks `data.db`, which holds the AFTM, CLAV and WEAV boards.
- **The startup risk:** `migrate()` runs every pending migration in one transaction when the plugin loads, so backfills would block the event loop at server start.
- **What's missing:** the Aleph release gate (the publisher thread, two fresh-guest runs, snapshot and canary per PHILOSOPHY §11) and a snapshot of `data.db` taken before migration.

**11. Major. §7 criteria leave room to "advance anyway".**
- "No critical defects" has no severity rubric.
- The Stage 1 performance row describes the workload but doesn't tie a pass to the separately "proposed" budgets.
- Stage 3 has no requirement of zero unexplained differences between old and new reads, and no count of consumers covered.
- No stage measures whether the fence works or whether duplicate claims occur across the two systems.
- Stage 5's "every scheduled consumer completed its cycle" has no bound on how long to wait and isn't tied to the manifest.
- **Fix:** define severities, set numeric thresholds and time windows, and add the metrics named in findings 3 and 8.

**12. Minor.**
- **(a) Import timestamps:** it isn't only comments. `createTask` also stamps `nowIso()` (`store.ts:788`), and `due_date` is date-only (`schema.ts:43`). Separately, the store accepts caller-supplied ULIDs (`createOrValidateUlid`, `store.ts:775/1372`), so import can use deterministic IDs for idempotency.
- **(b) Delete cascades:** `deleteTask` exists, and comments and task threads use `ON DELETE CASCADE`. The journal must not cascade, and managed tasks should be soft-deleted.
- **(c) Busy timeout:** the 5000 ms `busy_timeout` is **synchronous** in better-sqlite3. Any external process touching Tasks' `data.db` (a backup CLI, export tooling) can stall the whole server, which breaks the p99 ≤100 ms event-loop budget. Backups and snapshots should use the in-process online backup API.
- **(d) Imprecise citations:** `store:1088` is the start of the transaction; the `WHERE id = ?` is around line 1125. `CLI:670` is where the CLI is registered; the loop over each task's threads is at line 1428. These are imprecise but not wrong.

## Checks 1–7

| Check | Result |
|---|---|
| 1. Prior decision | Quote confirmed, at line 18 rather than 17. The plan is silent on it (finding 1). |
| 2. Citations | All 111 exist and are in range. I read the content of more than 25 across §1, §3, §4 and §5, and all were accurate (finding 12d). |
| 3. Load design | Batching and a persistent client are sound as transport. The Weaver-in-process idea contradicts §3 (findings 4 and 12c). |
| 4. Upstream split | Needs rework (findings 5 and 6). |
| 5. Inventory | Consumers are plausible, but tracker scope is badly undercounted (finding 2). There are duplicate-claim risks (findings 3, 7, 8). The failure-as-empty cases are correctly flagged (interlab `beads.go:88`, interkasten). |
| 6. Rollback | Stages 2–4 are not executable as written (finding 9). |
| 7. Acceptance | Partly falsifiable (finding 11). |

## What I could not verify

- **Live hub contents:** the depth of `mk-42j9`, edge types, and custom states.
- **Live services:** the bb server, `zklw-ci status`, and the AFTM board's contents.
- **beads CLI references:** the line numbers the plan cites from `bd --help` (B1–B7), and bd's source-level claim semantics.
- **Liveness:** whether the 57 trackers and the listed consumers are actively running. I only saw files on disk.
- **Unreproduced counts:** the 262/526 file counts, 750 cards, 77 stale beads, the 922 MB database, and the cause of the Sep 28 slowdown.
- **Upstream stance:** how get-bb maintainers would actually respond is my inference only.
