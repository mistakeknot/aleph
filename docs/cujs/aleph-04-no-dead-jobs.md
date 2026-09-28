---
artifact_type: cuj
journey: no-dead-jobs
actor: coordinator agent or scheduled job (dispatches), worker agent (runs), solo operator (approves reroutes)
criticality: p0
bead: none
---

# Your own accounts, budgeted

## Why This Journey Matters

The operator holds their own subscription accounts for each provider, and
uses each for their own work. Each has its own 5-hour and weekly limits,
which this journey treats as a budget to plan around, not something to
stretch. Three failures have been observed:

- **Bypass.** Scripted jobs launched the provider CLI directly, skipped
  the budgeted route, and failed on a login that had no budget left with
  no plan for it.
- **Transient refusal.** Temporary "no eligible account" refusals (429)
  killed two review threads that could have waited a few minutes.
- **Unplanned limit.** The operator's accounts for one provider all
  reached their weekly limits together. A producer thread died mid-task, and the work had to move to
  another model and provider.

A dead job wastes everything it spent so far, plus the coordinator's turns
spent working out what happened and restarting it.

### Current State vs. Planned

| Capability                                                                                                                         | Status                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Thread traffic routed to the operator's own accounts by priority and budget; an account's reported limits rechecked before refusal | **Shipped** (upstream Account Pooler)                           |
| `bb pool exec -- codex exec …` / `-- claude --print …` for scripted runs                                                           | **Shipped**                                                     |
| Argument allowlist; token only in the child's environment                                                                          | **Shipped**                                                     |
| `transport=pooled` / `pool-unconfirmed` marker; `bb pool exec` itself never retries                                                | **Shipped**                                                     |
| Callers record unconfirmed runs as unknown and don't replay them                                                                   | **Convention** (a caller rule; not enforced by bb)              |
| Budgeted Claude isolated from the calling folder's settings                                                                        | **Shipped**                                                     |
| Switch a thread's provider in place, keeping its place in the thread tree                                                          | **Shipped** (needs the local handoff plugin)                    |
| Transient refusals waited out instead of killing the thread                                                                        | **Planned**                                                     |
| Approaching-limit forecast, with a pause or reroute proposed to the operator                                                       | **Planned**                                                     |
| Live Codex run through `bb pool exec` verified                                                                                     | **Planned** (deferred: no budgeted account had quota available) |

## The Journey

A coordinator, or a job on the operator's server, needs a run. It
doesn't pick an account. It runs:

```
bb pool exec --stdin-file <path> -- claude --print …
```

The host checks the arguments, pins the provider and starts the
child with the machine token in its environment only. stderr begins with
`bb-pool-exec: transport=pooled provider=claude`, and the Account Pooler sends the
request to one of the operator's own accounts, in priority order, skipping any
account that is unavailable or at its threshold. If the Account
Pooler is unavailable before dispatch, the command fails with no marker and can be retried safely. If
contact is lost after dispatch, the marker reads
`transport=pool-unconfirmed`. `bb pool exec` never retries; recording the run
as unknown and not replaying it is the caller's job.

_Planned:_ when the provider briefly refuses every one of the operator's accounts, the run
waits with a bounded backoff instead of dying, and reports BLOCKED only if
the wait runs out.

_Planned:_ when the operator's accounts for a provider are heading for
their weekly limits, the coordinator hears about it in advance, with the
remaining quota for each provider. It proposes a next step to the
operator: pause this work until the reset, or move it to the other
provider. The Account Pooler uses only the operator's own accounts within
each account's own limits. It does not change any account's limits or hide usage, and it
moves work to another of the operator's accounts when one is unavailable or
at its threshold.

If a thread's provider does reach its limits mid-task, the operator switches the
provider in place from the model picker. The new thread takes over the
title, pin, section, parent and children, and the original is archived,
so the coordinator's tree stays intact and the work continues.

## Success Signals

| Signal                                     | Type       | Status  | Assertion                                                                                                                    |
| ------------------------------------------ | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Scripted runs use the budgeted route       | measurable | active  | stderr of each scripted run begins with `bb-pool-exec: transport=pooled provider=<provider>`                                 |
| No unplanned refusals                      | observable | active  | No scripted run dies on a refusal without a bounded wait or a BLOCKED report to the operator                                 |
| Unconfirmed runs aren't replayed           | observable | active  | After `transport=pool-unconfirmed`, `bb pool exec` starts no second attempt; callers that follow the convention don't either |
| Credential stays in the child              | measurable | active  | Machine token appears in no argument, file, log or output line                                                               |
| Provider switch keeps the tree             | measurable | active  | After switch-in-place, the new thread has the original's title, pin, section, parent and children                            |
| Transient refusals don't kill threads      | measurable | planned | A 429 "no eligible account" leads to a bounded wait, not a failed thread                                                     |
| Limits are seen in advance                 | observable | planned | The coordinator is told before the operator's accounts for one provider reach their weekly limits                            |
| Codex through `bb pool exec` verified live | observable | planned | A live `bb pool exec -- codex exec` run shows the pooled marker and completes                                                |

## Known Friction Points

- **Two providers, one machine.** `bb pool exec` covers Codex and Claude
  on the server's primary enrolled machine only.
- **No forecast.** Quota snapshots show where accounts are now, not when
  they'll reach their limits.
- **Switch-in-place needs the local handoff plugin**, and a CLI surface
  for it hasn't been confirmed.
- **Replay discipline is the caller's.** Aleph reports `pool-unconfirmed`,
  but refusing to replay depends on how each job is written.
