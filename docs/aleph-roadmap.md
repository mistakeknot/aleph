# Aleph — Roadmap

**Last reviewed:** 2026-09-24. **Current release:** `0.43.4+aleph.1`.

[Vision](aleph-vision.md) · [Backlog](aleph-backlog.md) · [Journeys](cujs/README.md) ·
[FORK.md](../FORK.md)

The goal is to make coordinator sessions spend their usage on project
progress. The order is: measure the waste, remove the largest sources
(wake storms and dead jobs), then bound review and returns, then rotation
and routing. Fork maintenance runs alongside, because every other item
depends on Aleph staying installed and current. The
[backlog](aleph-backlog.md) ranks individual items by expected savings.

## Where we are

`0.43.4+aleph.1` ships the first building blocks:

- `bb pool exec`: scripted runs use the account pool and report whether
  they ran pooled.
- Thread-bound availability: cross-provider borrowing is decided per
  thread and fails closed.
- Attempt receipts: account, model and usage per budgeted run.
- Pooled Claude isolated from caller settings; switching a thread's
  provider in place; provider icons.

The rest is convention: DONE/BLOCKED returns, the two-round review cap
and "no status-only wakes" are prompt rules. Nothing is measured yet. The
live receipt and Codex pool canaries are deferred, and upstream's in-app
update can still replace Aleph.

## Now

| Outcome | Serves | Done when |
|---|---|---|
| Outcome tag and inheritance | [Usage per outcome](cujs/aleph-06-usage-per-outcome.md#what-an-outcome-is) | Work is declared as an outcome at dispatch, and turns, children, pooled runs and receipts inherit its ID; untagged usage lands in `unattributed` |
| A waste baseline | [Usage per outcome](cujs/aleph-06-usage-per-outcome.md) | Wakes per task, retries, review rounds and duplicate runs are counted over one real project; the live receipt canary passes |
| Wakes only for news | [Multi-day project](cujs/aleph-01-multi-day-coordinator.md) | A child's non-final turns don't wake its parent; BLOCKED always does |
| Transient refusals don't kill threads | [No dead jobs](cujs/aleph-04-no-dead-jobs.md) | A "no eligible account" 429 leads to a bounded wait, not a failed thread; the live Codex pool canary passes |
| Aleph can't be replaced by one click | [Upstream update](cujs/aleph-07-upstream-update.md) | The in-app update prompt doesn't install plain upstream over Aleph |

## Next

| Outcome | Serves |
|---|---|
| Waits on outcomes, with deadlines that become BLOCKED | [Multi-day project](cujs/aleph-01-multi-day-coordinator.md) |
| Capped, structured returns checked by bb, with failures classified as environment or real | [Structured results](cujs/aleph-02-structured-child-results.md) |
| Reviews pinned to a commit and capped at two rounds, enforced instead of prompted; read-only reviewers | [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md) |
| Usage rolled up per outcome, visible to the operator | [Usage per outcome](cujs/aleph-06-usage-per-outcome.md) |
| Checkpoints for coordinator rotation, checked against live state | [Rotation](cujs/aleph-05-coordinator-rotation.md) |
| Update automation: range and overlap report, merge-and-qualify, switch runbook; Aleph builds ordered in update checks | [Upstream update](cujs/aleph-07-upstream-update.md), [remote access](cujs/aleph-08-remote-access-across-upgrade.md) |

## Later

| Outcome | Serves |
|---|---|
| Model choice per task class, tuned from outcome data | [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md) |
| Capacity forecast across providers, with reroutes proposed before a cliff | [No dead jobs](cujs/aleph-04-no-dead-jobs.md) |
| Environment preflight before expensive verification | [Structured results](cujs/aleph-02-structured-child-results.md) |
| Offer building blocks upstream when maintainers want them | [Vision](aleph-vision.md#the-diff-gets-smaller) |
| Revise personas and journeys after working sessions with the operator | [Personas](aleph-personas.md) |

## Decisions

- **What an outcome is** *(provisional, pending operator confirmation)*:
  a declared bb-native unit with an ID, a kind, an acceptance test and
  optionally an external reference. Usage is inherited from parent to
  child, and an outcome counts only when accepted on evidence. The
  headline is usage per accepted outcome, by kind, plus a waste ratio.
  See [usage per outcome](cujs/aleph-06-usage-per-outcome.md#what-an-outcome-is).

## Open questions

- Where should holding back child turns live, and would upstream want a
  general version of it?
- Can ordinary thread turns produce receipts, or only budgeted dispatch?
- Should pooled runs work from machines other than the primary one?

## Keeping this current

Review this file whenever an Aleph release is cut, a journey's status
changes, or new waste measurements arrive. The roadmap and backlog are
maintained by hand.
