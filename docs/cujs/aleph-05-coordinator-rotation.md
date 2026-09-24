---
artifact_type: cuj
journey: coordinator-rotation
actor: coordinator agent (hands off and resumes), solo operator (approves)
criticality: p1
---

# Rotate a coordinator cleanly from a checkpoint

## Why This Journey Matters

A coordinator that runs for days accumulates context. Eventually it
compacts, rotates to a fresh session, or moves to another provider after a
capacity cliff. Each time, the next session pays to rebuild what the old
one knew: goals, decisions and their reasons, which children are running,
what has been verified. Observed handoffs were sometimes stale, which led
to corrections of the form "production is NOT on X". Paying twice for the
same understanding is waste. Acting on a stale version of it is worse.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Compact a thread's context; fork a thread at a point | **Shipped** (upstream `bb thread compact`, `bb thread fork`) |
| Hand off to another provider in place, keeping title, pin, section, parent and children | **Shipped** (needs the local handoff plugin) |
| Written checkpoint with goals, decisions, open work and evidence | **Convention** (hand-written handoffs) |
| Checkpoint checked against live state before the new session trusts it | **Planned** |
| Rotation proposed when a coordinator's context passes a threshold | **Planned** |

## The Journey

A coordinator's context is getting full. *Planned:* bb notices this,
using the context usage it already records (`bb thread context`), and
suggests a rotation before quality drops.

The coordinator writes a checkpoint to an artifact, not only into its
transcript:

- the goal and end state;
- decisions made, with their reasons and who made them;
- running and blocked children, with their thread IDs;
- what has been verified, at which commits;
- open questions for the operator.

The new session starts from that checkpoint. *Planned:* before trusting
it, the new session checks the checkpoint's claims against live state,
such as branch heads, child thread statuses and the current release. It
flags anything that has changed rather than acting on it. Then it takes
over the old coordinator's place, using an in-place handoff so the
children stay attached, and the old session is archived.

The operator sees one message: rotated, and what (if anything) was found
to be stale.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Children stay attached | measurable | active | After an in-place handoff, the new coordinator has the old one's children and parent |
| Checkpoint is an artifact | observable | active | Each rotation leaves a checkpoint file with goals, decisions, open work and evidence |
| Fast resume | measurable | planned | The new session is working after one turn of reading the checkpoint, with no re-derivation turns |
| Stale claims caught | observable | planned | Checkpoint claims that no longer match live state are flagged before any action |
| No corrections from stale handoffs | qualitative | planned | The operator doesn't have to correct facts the new session inherited |
| Rotation before degradation | observable | planned | Rotation is suggested before the coordinator compacts involuntarily |

## Known Friction Points

- **Checkpoints are hand-written.** Their quality varies, and nothing
  checks them.
- **Compaction is lossy.** A compaction mid-task can drop decisions the
  coordinator still needs.
- **In-place handoff needs the local plugin**, and a CLI surface for it
  hasn't been confirmed.
