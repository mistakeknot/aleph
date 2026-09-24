---
artifact_type: cuj
journey: multi-day-coordinator
actor: coordinator agent (runs the project), solo operator (decides)
criticality: p0
bead: none
---

# Run a multi-day project without wake storms

## Why This Journey Matters

A coordinator that runs a project for days pays tokens and context for
every message it reads. When each child turn wakes it, it spends much of
its budget reading progress it can't act on. In one observed test run, a
single child caused 5–6 coordinator wakes with nothing actionable.
Coordinators also passed status-only messages to each other and to the
operator, which cost tokens and attention with no decision attached.

Waiting has the opposite failure. A coordinator that waits on the wrong
condition can stall silently. In one case, a coordinator waited for a CI
virtual machine process to exit before starting a rebuild. An idle process
lingered, the wait never ended, a planned maintenance window was missed,
and about 7 hours were lost. Wake storms waste tokens; stuck waits waste
time. This journey has to avoid both.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Wait for a thread's status and read its final output from the CLI | **Shipped** (upstream `bb thread wait`, `bb thread output`) |
| Children end their turn only as DONE or BLOCKED; no status-only messages | **Convention** (enforced only by prompt) |
| Parent woken only for DONE, BLOCKED or a decision | **Planned** |
| Status-only messages held back or folded into one update | **Planned** |
| Waits on outcomes, each with a deadline that becomes BLOCKED | **Planned** (by convention today) |
| Wakes per task recorded | **Planned** (see [usage per outcome](aleph-06-usage-per-outcome.md)) |

## The Journey

The operator gives a coordinator a project: a goal, an end state, and the
decisions they want to make themselves. The coordinator plans the work and
starts children with bounded tasks and a reporting rule. Each child ends
its turn only when DONE or BLOCKED, and its final message follows the
[structured return](aleph-02-structured-child-results.md).

While children work, the coordinator is idle and costs nothing. It isn't
woken by tool calls, intermediate turns or progress notes. *Planned:* bb
itself holds back a child's non-final turns from the parent, so the rule
doesn't depend on each child remembering its prompt. A BLOCKED result is
never held back.

When the coordinator has to wait for something outside bb, such as a CI
run, a deployment or a merge, it waits on that outcome directly: the check
result, the commit, the thread status. It doesn't wait on a stand-in such
as a process exiting. Every wait has a deadline. *Planned:* a wait that
reaches its deadline turns into a BLOCKED report with what was being
waited on and what was last seen, instead of waiting forever.

When a child reports, the coordinator reads one message, checks the
evidence and starts the next step. It sends the operator only decisions
and finished outcomes. When nothing is new, it ends its turn without
speaking. Over a multi-day project, the coordinator's turns track project
events, not child activity.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Final messages are classified | measurable | active | Every child's last message starts with `DONE:` or `BLOCKED:` |
| About one wake per outcome | measurable | planned | Coordinator wakes per finished child ≤ 1.2 over a project, excluding decisions |
| Blocks are never held back | observable | planned | A BLOCKED child wakes the parent immediately, even when other updates are held back |
| No status-only messages | observable | active | Coordinator messages to the operator each contain a decision request or a finished outcome |
| Every wait has a deadline | observable | planned | Each wait records its condition and deadline; none runs past its deadline without a BLOCKED report |
| Waits target outcomes | qualitative | active | Wait conditions name the result that matters (status, commit, check), not a process standing in for it |
| Operator sees fewer, better messages | qualitative | active | The operator's queue holds decisions and outcomes, not progress |

## Known Friction Points

- **It relies on prompts today.** A child that forgets the rule, or a
  provider that ends turns early, still wakes the parent.
- **"Idle" isn't "done".** A child that stops without a marker looks like
  one that finished. The coordinator has to read its output to tell.
- **Holding back needs a design.** Holding updates back versus merging
  them, and where that policy lives (on the server, under bb's rules), is
  still open. Upstream may want a general version.
- **Deadlines need judgment.** A deadline set too short turns slow but
  healthy work into BLOCKED reports.
