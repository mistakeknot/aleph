---
artifact_type: cuj
journey: upstream-update
actor: solo operator (approves), coordinator agent (prepares)
criticality: p1
bead: none
---

# Update Aleph to a new upstream release

*Supporting journey.* It keeps the orchestration pieces behind the other
journeys current and safe to change.

## Why This Journey Matters

Aleph is only useful while it tracks current bb. Upstream moves fast, with
several commits a week and the occasional revert. If each update takes a day
of hand merging and a nervous switch, the operator stops taking updates, the
fork drifts, and every later merge gets harder. The first reason Aleph exists
is that a hand-applied upgrade once erased the operator's local changes. This
journey must never repeat that.

The failure has two sides. A skipped update leaves the operator without
upstream fixes. A careless one can break a server that is running live agent
work. The journey has to be cheap enough to repeat and safe enough to trust.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Upstream merged (not rebased), with conflicts recorded in the merge commit | **Shipped** (manual) |
| Version set to `<upstream>+aleph.<n>` in both version files, checked for lockstep | **Shipped** (manual; `bump-version` refuses build metadata) |
| Changelog entry naming the upstream commit included | **Shipped** (manual) |
| Credential-free release check run twice at the exact SHA on fresh machines by the fork's CI | **Shipped** |
| Script that computes the upstream range and its overlap with carried patches | **Planned** |
| Merge-and-qualify pipeline | **Planned** |
| Switch runbook script: drain, snapshot, switch, canary, rollback | **Planned** |
| `bump-version` accepts `+aleph.<n>`; update checks order Aleph builds | **Planned** |

## The Journey

Upstream publishes a release. A coordinator thread notices and prepares the
update so that the operator only makes the final decision.

It first works out what changed: the upstream commit range since the base of
the current Aleph version, and which of those commits touch files that carried
patches also touch. Today this is done by hand with `git log` and `git diff`;
the planned range script will produce it as a report. Overlaps are what need
attention. An upstream commit that fixes something Aleph patched is a chance
to drop the patch.

The coordinator merges upstream into the release line and resolves conflicts,
recording each one in the merge commit message. It sets the new version in
`packages/bb-app/package.json` and `apps/desktop/package.json` (for example
`0.43.5+aleph.1`), which the lockstep check verifies, and writes a changelog
entry naming the upstream commit it includes. `git log --no-merges <upstream
main>..HEAD` should still list every carried patch.

The fork's CI then qualifies that exact commit. It runs the credential-free
release check twice on fresh isolated machines, and both runs must pass. A
reviewer independent of the author checks the merge, with extra attention to
the overlaps.

The operator gets one summary: the upstream range, the overlaps and how each
was resolved, the qualification results, and the review verdict. They
approve or decline.

On approval, the switch runs in order. It drains new work by setting the
concurrency limit to 0, waits for running turns to finish, takes a quiesced
snapshot of the server's data, installs the qualified build, and runs a
canary. The canary opens the app remotely, starts a thread, and checks that
the carried features are present (pooled runs, thread-bound
availability, receipts, provider switching). If the canary fails, the switch rolls back
to the snapshot and the previous build. If it passes, the limit is restored
and queued work continues.

### Rolling back after enrolled daemons have self-updated

Rolling the server back to the snapshot and previous build is not enough by
itself when the release being rolled back from bumped the host-daemon
protocol. An enrolled machine's daemon self-updates to follow the server's
protocol, but `protocol-self-update.ts` refuses to downgrade: a daemon
already on the newer protocol logs "Server protocol is older than this
daemon; refusing to downgrade" against the rolled-back server and stays
disconnected. For example, aleph.3 moved enrolled daemons to protocol 218;
rolling back to aleph.2 (protocol 217) strands any daemon that already took
218 until it is reinstalled by hand with `bb machine reconnect <machine>`.
A Mac using the desktop app's bundled daemon needs the desktop app rebuilt
and reinstalled at the rolled-back version too, since its daemon does not
self-update. Check `launchctl list | grep app.getbb.host-daemon` (or the
platform equivalent) on each enrolled machine after a rollback that follows
a protocol-bumping release.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Carried patches survive the merge | measurable | active | `git log --no-merges <upstream main>..HEAD` lists every carried patch named in FORK.md |
| Version files agree | measurable | active | The version lockstep check passes for both version files |
| Qualified at the exact commit | measurable | active | Two passing release-check runs on fresh machines at the SHA that will be installed; none at a different SHA counts |
| Changelog names the upstream base | observable | active | The new `CHANGELOG.md` entry names the upstream release and main commit |
| Overlaps are known before merging | measurable | planned | The range script's report lists every upstream commit touching a file that a carried patch touches |
| No work is lost at the switch | observable | planned | Running-turn count is 0 when the snapshot is taken; queued messages start after the switch |
| Rollback is ready before install | observable | planned | A snapshot and the previous build exist and are recorded before the new build is installed |
| Carried features present after switch | observable | active | Canary sees provider icons, pooled runs and remote access working on the new build |
| One decision per release | qualitative | planned | The operator's only action is approve or decline on a single summary |

## Known Friction Points

- **Everything before the switch is manual.** Range, merge, version and
  changelog are done by hand or by an agent following notes. *Planned: the
  three update-automation scripts.*
- **`bump-version` refuses `+aleph.<n>`.** Versions are set directly in both
  files. *Planned: teach it build metadata.*
- **Update checks don't order Aleph builds.** `0.43.4+aleph.2` isn't offered
  over `0.43.4+aleph.1`. *Planned.*
- **The in-app update prompt can install plain upstream over Aleph.** A
  single click replaces the fork. *Planned: offer "merge into Aleph"
  instead.*
- **What's New shows upstream's changelog, not Aleph's.** *Planned.*
- **Live canaries depend on provider capacity.** Canaries that need a model
  run can be blocked when accounts are exhausted, as happened for
  `0.43.4+aleph.1`.
