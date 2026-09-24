---
artifact_type: cuj
journey: no-dead-jobs
actor: coordinator agent or scheduled job (dispatches), worker agent (runs), solo operator (approves reroutes)
criticality: p0
bead: none
---

# No job dies on one exhausted account

## Why This Journey Matters

The operator holds several subscription accounts for each provider. Each
has its own 5-hour and weekly limits, and they run out at different
times, sometimes all at once. Three failures have been observed:

- **Bypass.** Scripted jobs launched the provider CLI directly, skipped
  the pool, and failed on exhausted logins while other accounts had
  headroom.
- **Transient refusal.** Temporary "no eligible account" refusals (429)
  killed two review threads that could have waited a few minutes.
- **Provider cliff.** Every account for one provider hit its weekly limit
  at once. A producer thread died mid-task, and the work had to move to
  another model and provider.

A dead job wastes everything it spent so far, plus the coordinator's turns
spent working out what happened and restarting it.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Thread traffic spread across pooled accounts; exhausted accounts rechecked before refusal | **Shipped** (upstream Account Pooler) |
| `bb pool exec -- codex exec …` / `-- claude --print …` for scripted runs | **Shipped** |
| Argument allowlist; token only in the child's environment | **Shipped** |
| `transport=pooled` / `pool-unconfirmed` marker; `bb pool exec` itself never retries | **Shipped** |
| Callers record unconfirmed runs as unknown and don't replay them | **Convention** (a caller rule; not enforced by bb) |
| Pooled Claude isolated from the calling folder's settings | **Shipped** |
| Switch a thread's provider in place, keeping its place in the thread tree | **Shipped** (needs the local handoff plugin) |
| Transient refusals waited out instead of killing the thread | **Planned** |
| Provider-wide cliff forecast, with a reroute proposed to the operator | **Planned** |
| Live Codex run through `bb pool exec` verified | **Planned** (deferred: no provider capacity) |

## The Journey

A coordinator, or a job on the operator's server, needs a run. It
doesn't pick an account. It runs:

```
bb pool exec --stdin-file <path> -- claude --print …
```

The host checks the arguments, pins the pooled provider and starts the
child with the machine token in its environment only. stderr begins with
`bb-pool-exec: transport=pooled provider=claude`, and the pool sends the
request to an account with headroom. If the pool is unavailable before
dispatch, the command fails with no marker and can be retried safely. If
contact is lost after dispatch, the marker reads
`transport=pool-unconfirmed`. `bb pool exec` never retries; recording the run
as unknown and not replaying it is the caller's job.

*Planned:* when every account for the provider is briefly refused, the run
waits with a bounded backoff instead of dying, and reports BLOCKED only if
the wait runs out.

*Planned:* when all of a provider's accounts are heading for their
weekly limit, the coordinator hears about it before the cliff, with the
remaining capacity for each provider. It proposes a reroute to the
operator: move this work to the other provider, or pause it until the
reset.

If a thread's provider does run out mid-task, the operator switches the
provider in place from the model picker. The new thread takes over the
title, pin, section, parent and children, and the original is archived,
so the coordinator's tree stays intact and the work continues.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Scripted runs use the pool | measurable | active | stderr of each scripted run begins with `bb-pool-exec: transport=pooled provider=<provider>` |
| No exhausted-login failures with headroom left | observable | active | No pooled run fails on an exhausted account while `bb pool status` shows another account with capacity |
| Unconfirmed runs aren't replayed | observable | active | After `transport=pool-unconfirmed`, `bb pool exec` starts no second attempt; callers that follow the convention don't either |
| Credential stays in the child | measurable | active | Machine token appears in no argument, file, log or output line |
| Provider switch keeps the tree | measurable | active | After switch-in-place, the new thread has the original's title, pin, section, parent and children |
| Transient refusals don't kill threads | measurable | planned | A 429 "no eligible account" leads to a bounded wait, not a failed thread |
| Cliffs are seen in advance | observable | planned | The coordinator is told before all of one provider's accounts reach their weekly limit |
| Codex through the pool verified live | observable | planned | A live `bb pool exec -- codex exec` run shows the pooled marker and completes |

## Known Friction Points

- **Two providers, one machine.** `bb pool exec` covers Codex and Claude
  on the server's primary enrolled machine only.
- **No forecast.** Quota snapshots show where accounts are now, not when
  they'll run out.
- **Switch-in-place needs the local handoff plugin**, and a CLI surface
  for it hasn't been confirmed.
- **Replay discipline is the caller's.** Aleph reports `pool-unconfirmed`,
  but refusing to replay depends on how each job is written.
