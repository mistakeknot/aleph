---
artifact_type: cuj
journey: child-thread-reporting
actor: coordinator agent
criticality: p1
---

# Coordinate child threads cheaply

## Why This Journey Matters

A coordinator thread splits work into child threads and waits for results.
It pays in tokens and context for everything it reads. When every child
turn wakes the coordinator, a coordinator watching six children pays for
dozens of progress updates it didn't need. That leaves less context for
decisions that matter and brings compaction on sooner. Over a long session,
the coordinator can spend more on watching than on coordinating.

The opposite failure is worse. If updates are cut too far, a child that is
stuck on a question for the operator waits unseen. What the coordinator
needs is a small, reliable signal: finished or blocked, and why.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Coordinator can wait for a child's status and read its final output from the CLI | **Shipped** (upstream `bb thread wait`, `bb thread output`) |
| Children told to end their turn only as DONE or BLOCKED | **Convention** (instructions in the child's prompt) |
| DONE/BLOCKED-only returns, or coalesced progress, as a bb feature | **Planned** |
| Per-coordinator accounting of tokens spent on child updates | **Planned** |

## The Journey

The coordinator starts a child with a bounded task and a reporting rule:
end the turn only when DONE or BLOCKED, start the final message with
`DONE:` or `BLOCKED:`, and include the evidence (commits, files, check
output) or the missing decision.

While the child works, the coordinator does other things. It isn't woken
for tool calls, intermediate reasoning or "still working" messages. Today
that depends on the child following instructions and on the coordinator
using `bb thread wait` rather than polling. The planned feature (not built yet) makes it
structural. A child's non-final turns are either held back from the parent
or folded into one coalesced update.

When the child finishes, the coordinator reads one message, checks the
evidence, and moves on. When the child is blocked, the message names what
it needs: a decision, a credential step, or an unavailable service. The
coordinator either answers from context or passes one clear question to the
operator.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Final message is classified | measurable | active | Each child's last message starts with `DONE:` or `BLOCKED:` |
| DONE carries evidence | observable | active | A DONE message names commits, files or check output the coordinator can verify |
| BLOCKED names the need | qualitative | active | A BLOCKED message states the single decision or action required to continue |
| Parent wakes once per outcome | measurable | planned | A child's completion or block wakes the parent once; intermediate turns don't |
| Blocks are never coalesced away | observable | planned | Any BLOCKED outcome reaches the parent immediately, even with coalescing on |
| Coordinator spend on watching falls | measurable | planned | Tokens a coordinator spends on child updates per completed child go down compared with per-turn wakes |

## Known Friction Points

- **It relies on prompts today.** A child that forgets the rule, or a
  provider that ends turns early, still wakes the parent with partial
  progress.
- **Aleph can't yet distinguish "done" from "idle".** A child that stops
  without a DONE or BLOCKED marker looks the same as one that finished.
  The coordinator has to read the output to tell them apart.
- **Coalescing design is open.** Holding updates back versus merging them
  into one, and where that policy lives (server, not daemon, under bb's
  rules), still has to be decided.
- **Upstream fit unknown.** This may be something upstream wants in a
  general form; if so, it should be designed with them.
