---
artifact_type: cuj
journey: cross-provider-review
actor: coordinator agent (requests), reviewer agent (reviews)
criticality: p1
---

# Borrow the other provider for an independent review

## Why This Journey Matters

A review by the same model that wrote the change tends to share its blind
spots. The operator often wants a reviewer from the other lab: a Claude
review of Codex work, or the reverse. That means a thread running on one
provider has to use the other provider's pooled accounts.

That borrowing must be decided for each thread. Pool-wide switches can say
"cross-provider use is on", but they can't say whether *this* thread on
*this* machine is allowed. If the answer is wrong one way, the review can't
happen. If it's wrong the other way, a thread the operator never approved
spends another provider's quota.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Thread-bound availability: `GET …/account-pool/http/availability?threadId=<id>` | **Shipped** |
| Ownership checked: the thread's environment must belong to the calling, enrolled machine | **Shipped** |
| 403 on refusal, 503 when ownership can't be checked, responses never cached | **Shipped** |
| Reviewer run through the other provider's pool with `bb pool exec` | **Shipped** (see [pooled runs](aleph-02-pooled-agent-runs.md)) |
| Enforced read-only mode for reviewer runs | **Planned** (by instruction today) |

## The Journey

A coordinator on Codex has a finished change and wants a Claude review.
Before dispatching anything, it asks the availability route for its own
thread ID. The response lists, for each provider, whether this thread may
use that pool, and it echoes the thread ID. A response that doesn't name
the thread isn't proof of permission, and the coordinator treats it as a
refusal.

If the answer is 403, the thread isn't owned by the calling machine, or
the machine is no longer enrolled. If it's 503, ownership couldn't be
checked. In both cases the coordinator doesn't borrow. It reports BLOCKED
with the reason, and the review waits or goes to the operator.

If Claude is available for the thread, the coordinator starts the reviewer
through the pool with `bb pool exec -- claude --print …`. The prompt says
what to review, what is out of scope, the number of rounds, and that the
reviewer must not change files. The reviewer reads the change and returns
findings with a verdict. The coordinator records which provider and account
reviewed what, and uses a receipt if the run is budgeted.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Eligibility is per thread | measurable | active | The availability response names the requested thread ID; a response without it isn't used as permission |
| Unowned threads refused | measurable | active | Thread whose environment belongs to another machine → 403 |
| Unknown ownership refused | measurable | active | Failed ownership lookup → 503, never an allow |
| Answers aren't cached | measurable | active | Availability responses carry no-store; a changed ownership is reflected on the next call |
| No credentials in the answer | measurable | active | The availability response contains no tokens or account secrets |
| Reviewer is from the other lab | observable | active | The review's pooled-transport marker names a different provider from the author's |
| Reviewer changes nothing | observable | planned | The working tree and branch are unchanged after a review run; enforced, not only instructed |
| Review is bounded | qualitative | active | Review ends within the stated rounds, with open disagreements passed to the operator |

## Known Friction Points

- **Read-only is only instructed.** Nothing yet prevents a reviewer run
  from editing files. *Planned.*
- **Only on the primary machine.** Borrowing through `bb pool exec` has the
  same machine restriction as pooled runs.
- **Borrowing depends on the other pool's capacity.** When the other
  provider's accounts are exhausted, the review waits. Switching to another
  destination isn't a fallback.
