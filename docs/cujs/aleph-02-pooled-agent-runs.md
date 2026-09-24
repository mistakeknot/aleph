---
artifact_type: cuj
journey: pooled-agent-runs
actor: coordinator agent or scheduled job (dispatches), worker agent (runs)
criticality: p0
---

# Run many agents on pooled accounts

## Why This Journey Matters

The operator has several subscription accounts for each provider. Each one
hits its 5-hour and weekly limits at a different time. bb's Account Pooler
already spreads thread traffic across them. Scripted work, such as scheduled
reviewers or jobs a coordinator dispatches, used to launch the provider CLI
directly. That skipped the pool and tied each job to whichever login the CLI
happened to have. Jobs then failed on exhausted accounts while other accounts
still had headroom.

At that point capacity is wasted and scheduled work fails silently. The
coordinator then spends tokens diagnosing a failure that was just bad
routing. The worst case is a run that *seems* pooled but isn't, and so
spends quota the operator didn't plan for.

### Current State vs. Planned

| Capability | Status |
|---|---|
| `bb pool exec -- codex exec …` and `bb pool exec -- claude --print …` on the server's primary machine | **Shipped** |
| Argument allowlist; config, profile and provider overrides rejected | **Shipped** |
| `transport=pooled` / `pool-unconfirmed` marker on stderr | **Shipped** |
| Machine token only in the child's environment | **Shipped** |
| Prompts through `--stdin-file` from a private host directory | **Shipped** |
| Pooled Claude uses host-owned settings, not the caller folder's | **Shipped** |
| Attempt receipts for budgeted dispatch; 503 before spend when unavailable | **Shipped** |
| Live Codex run through `bb pool exec` verified | **Planned** (deferred: no provider capacity) |
| Live receipt canary | **Planned** (deferred: no provider capacity) |

## The Journey

A coordinator thread, or a job on the operator's server, needs to run a
review. It doesn't pick an account. It writes the prompt into the host's
private exec-input directory and runs:

```
bb pool exec --stdin-file <path> -- claude --print …
```

The host checks the arguments against the allowlist and rejects anything
that would change the provider, config or profile. It pins the pooled
provider and starts the child with the machine token in its environment
only. For Claude, the host sets its own settings sources, so settings from
the folder the job was started in don't apply. When the child has really
started through the pool, stderr begins with
`bb-pool-exec: transport=pooled provider=claude`. The pool sends the
request to an account with headroom. The command exits with the child's
status.

If the pool is unavailable, or the host is offline before dispatch, the
command fails with no marker and the job can retry safely. If contact is
lost after dispatch, the marker reads `transport=pool-unconfirmed`. The job
records that the run may have happened and does **not** retry it.

For budgeted work, the dispatcher first begins an attempt with the
receipts API. If the hub can't issue receipts, begin returns 503 and the
dispatcher stops before spending any quota. Otherwise it runs one process
with a scoped token and finalizes the attempt. The result is a sealed
record of every upstream request and account hop, showing which account
and model ran and what was used.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Pooled start is marked | measurable | active | stderr of a successful start begins with `bb-pool-exec: transport=pooled provider=<provider>` |
| Failure before dispatch leaves no marker | measurable | active | Pool unavailable or host offline → non-zero exit and no `transport=` line |
| Unconfirmed runs aren't replayed | observable | active | After `transport=pool-unconfirmed`, the dispatcher logs the run as unknown and starts no second attempt |
| Disallowed arguments rejected | measurable | active | Config, profile, provider selector or unknown options → rejected before any child starts |
| Credential stays in the child | measurable | active | Machine token appears in no argument, file, log or stdout/stderr line |
| Caller folder settings ignored | measurable | active | A pooled Claude run started from a folder with project settings uses only host-owned settings |
| No exhausted-login failures with headroom left | observable | active | No pooled job fails on an exhausted account while `bb pool status` shows another account with capacity |
| Budget stops before spend | measurable | active | Receipt begin returning 503 → no provider process starts |
| Every budgeted run has a receipt | measurable | planned | Live canary: finalized receipt names account, model and usage for a real run |
| Codex through the pool verified live | observable | planned | Live `bb pool exec -- codex exec` run shows the pooled marker and completes |

## Known Friction Points

- **Primary machine only.** `bb pool exec` runs on the server's primary
  enrolled machine. Jobs on other machines still need another path.
- **Two providers only.** Codex and Claude. Other providers aren't covered.
- **Live canaries deferred.** Both live checks were blocked by provider
  capacity at release time, so they are verified in tests but not yet with
  real runs.
- **`pool-unconfirmed` requires the caller to be disciplined.** Aleph
  reports the state, but whether a job refuses to replay depends on how it
  was written.
