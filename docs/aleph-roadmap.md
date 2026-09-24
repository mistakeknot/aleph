# Aleph — Roadmap

**Last reviewed:** 2026-09-24. **Current release:** `0.43.4+aleph.1`.

[Vision](aleph-vision.md) · [Backlog](backlog.md) · [Journeys](cujs/README.md) ·
[FORK.md](../FORK.md)

The immediate goal is to make taking the next upstream release a routine,
safe step, and to stop Aleph from being overwritten by accident. Everything
here comes from [journeys](cujs/README.md) and from work left open by the
first release. The [backlog](backlog.md) has the item-level priorities.

## Where we are

- `0.43.4+aleph.1` is frozen. It carries Account Pooler 0.1.2 (thread-bound
  availability, `bb pool exec`, attempt receipts, isolated pooled Claude),
  provider icons, switch-in-place, optional composer focus on pane switches,
  and the fork's credential-free release check.
- Updates are done by hand: range, merge, version, changelog and switch.
- The live Codex `bb pool exec` canary and the live receipt canary are
  deferred. Provider capacity wasn't available when the release was frozen.
- Nothing yet stops upstream's in-app update from replacing Aleph.

## Now

| Outcome | Serves | Done when |
|---|---|---|
| Aleph can't be replaced by one click | [Update journey](cujs/aleph-01-upstream-update.md), [vision](aleph-vision.md#aleph-knows-its-aleph) | The in-app update prompt doesn't install plain upstream over Aleph and offers to merge the release into Aleph instead |
| Aleph builds are ordered | [Update journey](cujs/aleph-01-upstream-update.md) | `bump-version` accepts `+aleph.<n>`, and update checks offer `+aleph.2` over `+aleph.1` |
| The next update starts from a report | [Update journey](cujs/aleph-01-upstream-update.md), [remote access](cujs/aleph-06-remote-access-across-upgrade.md) | A script lists the upstream range, overlaps with carried patches, and commits that touch connect or pairing |
| First release fully verified | [Pooled runs](cujs/aleph-02-pooled-agent-runs.md) | Live Codex `bb pool exec` and receipt canaries pass; the pooled Claude config fix is confirmed at the switch |

## Next

| Outcome | Serves |
|---|---|
| Merge-and-qualify pipeline: merge, version, changelog and two fresh-machine qualification runs at one SHA | [Update journey](cujs/aleph-01-upstream-update.md) |
| Switch runbook script: drain, quiesced snapshot, install, canary including remote access, rollback | [Update journey](cujs/aleph-01-upstream-update.md), [remote access](cujs/aleph-06-remote-access-across-upgrade.md) |
| Coordinators woken only on DONE or BLOCKED, with coalesced progress | [Child reporting](cujs/aleph-03-child-thread-reporting.md) |
| What's New shows Aleph's changelog | [Vision](aleph-vision.md#aleph-knows-its-aleph) |
| Reviewer runs enforced read-only | [Cross-provider review](cujs/aleph-04-cross-provider-review.md) |
| Switch-in-place available from the `bb` CLI | [Switch in place](cujs/aleph-05-provider-switch-in-place.md) |

Once the pipeline and runbook exist, the target is one operator approval per
upstream release.

## Later

| Outcome | Serves |
|---|---|
| Offer patches upstream when maintainers want them: provider icons, `bb pool exec`, thread-bound availability | [Vision](aleph-vision.md#the-diff-gets-smaller) |
| Measure what coordinators spend on child updates | [Child reporting](cujs/aleph-03-child-thread-reporting.md) |
| Revise personas and journeys after working sessions with the operator | [Personas](personas.md) |

## Open questions

- Where should child-report coalescing live, and would upstream want a
  general version of it?
- Should pooled runs be available from machines other than the primary one,
  or is the current restriction the right boundary?
- How should the update prompt behave for Aleph users who really do want to
  go back to plain upstream?

## Keeping this current

Review this file whenever an Aleph release is cut or a journey's status
changes. The roadmap and backlog are maintained by hand.
