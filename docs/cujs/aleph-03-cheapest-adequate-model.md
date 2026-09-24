---
artifact_type: cuj
journey: cheapest-adequate-model
actor: coordinator agent (routes and requests review), reviewer agent (reviews)
criticality: p1
bead: none
---

# Route work to the cheapest adequate model, with bounded cross-provider review

## Why This Journey Matters

Frontier models are the scarcest capacity the operator has. Using them
for routine work drains weekly limits sooner. Using a weaker model for work
that needs a stronger one costs more in rework than it saves. The aim is
the cheapest model that clears the quality bar for the task.

Review is where usage has leaked the most. One change went through four
independent review rounds with an escalation partway through, before a
cap of two rounds and then a human decision was set. Reviews were re-run
after reviewer-routing rules changed underneath them. Others started
against a branch the producer was still pushing to, so they reviewed the
wrong target. A stop command matched its own shell and killed a freshly
launched review. Independent review from the other provider is worth
having. Unbounded or mis-targeted review isn't.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Thread-bound availability: may *this* thread use each provider's pool | **Shipped** |
| Ownership checked; 403 on refusal, 503 when unknown, never cached | **Shipped** |
| Reviewer run on the other provider's pool with `bb pool exec` | **Shipped** |
| Provider icons show which provider each thread uses | **Shipped** |
| Review pinned to a commit; at most two rounds, then a human | **Convention** (prompt) |
| Model choice per task class against a quality bar | **Planned** |
| Enforced read-only reviewer runs | **Planned** |
| Stop a run by its ID, never by matching a command line | **Planned** (upstream `bb thread stop` covers threads) |

## The Journey

The coordinator has a task. It chooses a model for the task class:
routine edits and mechanical checks go to a cheaper model, and planning,
difficult debugging and foundational changes go to a frontier model.
*Planned:* bb records that choice and its outcome, so the rule can be
tuned from evidence rather than habit.

When the change is ready and independence matters, the coordinator asks
for a review from the other provider. First it checks thread-bound
availability for its own thread ID. A response that doesn't name the
thread isn't permission. A 403 means the thread isn't owned by this
machine, and a 503 means ownership couldn't be checked. In both cases the
coordinator reports BLOCKED and doesn't borrow.

If borrowing is allowed, the coordinator pins the review to a commit
SHA and starts the reviewer through the pool with
`bb pool exec -- claude --print …` (or `codex exec` in the other
direction). The prompt names the target commit, the scope, the round
limit and that the reviewer must not change files. If the producer
pushes again, the review continues on the pinned commit, and a new
commit means a new, deliberate review. A change to routing rules doesn't
invalidate a review that has already started.

After two rounds, open disagreements go to the operator as one decision.
If a review needs to be stopped, it's stopped by its thread or run ID, so
the stop can't hit anything else.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Borrowing is per thread | measurable | active | Availability response names the requested thread ID; otherwise it isn't used as permission |
| Unknown or unowned is refused | measurable | active | Unowned thread → 403; failed ownership lookup → 503; responses are not cached |
| Review is independent | observable | active | The reviewer's pooled-transport marker names a different provider from the producer's |
| Review has a fixed target | observable | active | Every review names one commit SHA; findings refer to that SHA |
| Review is bounded | measurable | active | No change goes past two review rounds without an operator decision |
| No duplicate reviews | measurable | planned | Reviews per change per commit ≤ 1, excluding deliberate re-reviews |
| Reviewer changes nothing | observable | planned | Working tree and branch unchanged after a review run; enforced, not only instructed |
| Model fits task | qualitative | planned | Rework rate for cheaper-model tasks stays at or below the frontier rate for the same task class |

## Known Friction Points

- **Routing is by habit.** There's no recorded mapping from task class to
  model yet, and no outcome data to tune it.
- **Bounds are prompt-only.** Round caps and commit pinning depend on
  instructions.
- **Read-only is only instructed.**
- **Borrowing depends on the other pool's capacity.** When it's
  exhausted, the review waits. Switching destination isn't a fallback.
- **Primary machine only.** `bb pool exec` runs on the server's primary
  enrolled machine.
