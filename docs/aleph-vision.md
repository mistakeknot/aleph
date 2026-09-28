# Aleph — Vision

**Version:** 0.2
**Date:** 2026-09-24
**Status:** Draft

[Mission](../MISSION.md) · [Philosophy](../PHILOSOPHY.md) ·
[Personas](aleph-personas.md) · [Journeys](cujs/README.md) ·
[Roadmap](aleph-roadmap.md) · [Backlog](aleph-backlog.md)

---

## The idea

bb can run many coding-agent threads across machines and providers. The
most productive way to use it is also the most expensive: a long-lived
coordinator thread runs a project for days, starts child threads for
implementation and review, and passes decisions to a human operator.

Most of the cost of that setup isn't the work. It's orchestration done
badly. Coordinators are woken for nothing, waits never end, reviews loop,
work is duplicated, jobs die on a refusal with no plan for it, and long sessions
pay again to rebuild state they had already worked out. Aleph exists to make
that orchestration cheap and reliable, so the operator's usage across
providers turns into project output and quality.

## Where the usage went

Over two days of real coordinator operation, these patterns showed up:

| Pattern                             | What happened                                                                                                                                                                                       | What it cost                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Wake storms**                     | Children ended a turn for every progress update, and each turn end woke the coordinator                                                                                                             | One long test run caused 5–6 coordinator wakes with nothing to act on                        |
| **Wrong wait conditions**           | A coordinator waited for a CI virtual machine process to exit before rebuilding; an idle process lingered                                                                                           | The wait never ended; a maintenance window was missed; about 7 hours lost                    |
| **Unbounded review**                | One change went through 4 independent review rounds with an escalation, and reviews were re-run after the reviewer-routing rules changed                                                            | Repeated full reviews for one change                                                         |
| **Duplicate and orphaned work**     | Reviews started against a branch the producer was still pushing to; a stop command matched its own shell and killed a fresh review                                                                  | Reviews of the wrong target and killed work, both redone                                     |
| **Unplanned refusals**              | The operator's own accounts for one provider all reached their weekly limits together; transient "no eligible account" refusals killed two review threads; scripted jobs skipped the budgeted route | A producer died mid-task and had to move provider; jobs failed instead of waiting or pausing |
| **Status churn**                    | Coordinators passed status-only messages to each other and to the operator                                                                                                                          | Tokens and attention with no decision attached                                               |
| **Context-heavy coordinators**      | Long sessions filled up, compacted or rotated, then re-derived state, sometimes from stale handoffs                                                                                                 | Paying twice for the same understanding, plus corrections                                    |
| **Verification in the wrong place** | Build checks failed on environment problems (missing native modules or type declarations, machine load)                                                                                             | A full rebuild cycle before the real result each time                                        |

Some of these are now handled by rules the operator gives in prompts: return
only DONE or BLOCKED, at most two review rounds and then a human decision,
no status-only wakes. Rules in prompts help, but they rely on every agent
following them every time. Aleph's job is to build them into bb.

## What good looks like

- Every token spent moves a project forward.
- Coordinators wake only on DONE, BLOCKED or a decision.
- Work goes to the cheapest model that meets the quality bar, with
  independent cross-provider review when it matters, bounded in rounds.
- Each of the operator's own accounts is budgeted and its usage forecast,
  so no job dies without a plan to wait, pause or ask the operator.
- Child returns are capped and structured.
- Long coordinator sessions rotate cleanly from checkpoints.
- Waste is measured: usage per outcome, wakes per task, retries.

## Where Aleph is now: the first building blocks

`0.43.4+aleph.1` (upstream bb 0.43.4 plus main through `fdd3de3`) ships
the first pieces. [FORK.md](../FORK.md) has the details.

| Shipped                                       | What it gives the mission                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bb pool exec` for Codex and Claude           | Scripted and supervised runs use the operator's own accounts under their budget instead of an unmanaged login, and say whether they really ran budgeted |
| Thread-bound availability                     | Using another provider's accounts, for example for an independent review, is decided per thread and fails closed                                        |
| Attempt receipts for budgeted dispatch        | A sealed record of account, model and usage per run; the basis for measuring usage per outcome                                                          |
| Budgeted Claude isolated from caller settings | Budgeted runs behave the same wherever they're started                                                                                                  |
| Switch a thread's provider in place           | Work can move provider when the operator chooses, without losing its place in the thread tree                                                           |
| Provider icons in the thread list             | The operator can see which provider each thread is using                                                                                                |

From upstream bb, Aleph also relies on `bb thread wait` and
`bb thread output`, the concurrency limit, thread compaction, and the
Account Pooler's recheck of an account's reported limits before it refuses a request.

Not yet: DONE/BLOCKED as a structural rule, capped returns, outcome waits
with deadlines, bounded review, checkpoints for rotation, usage
forecasts, and any measure of usage per outcome. The live receipt canary
and a live Codex run through `bb pool exec` were deferred because no
budgeted account had quota available.

## Where Aleph is going (next 6–12 months)

These are goals, not shipped features. The [roadmap](aleph-roadmap.md)
orders them.

### Measure first

Record wakes per task, retries, review rounds and usage per outcome, using
receipts where possible. This gives a baseline, so each later change can
show what it saved. Journey:
[see usage per outcome](cujs/aleph-06-usage-per-outcome.md).

### Coordinators wake only for news

DONE/BLOCKED-only wakes become a bb feature instead of a prompt rule.
Status-only messages are held back, waits target outcomes and have
deadlines. Journey: [run a multi-day project without wake storms](cujs/aleph-01-multi-day-coordinator.md).

### Returns are capped and structured

Child results have a fixed shape and size, carry evidence, and classify
failures as environment problems or real ones. Journey:
[children return capped, structured results](cujs/aleph-02-structured-child-results.md).

### Right model, bounded review

Work goes to the cheapest model that clears the bar. Cross-provider
review is per thread, pinned to a commit and limited in rounds. Journey:
[route to the cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md).

### Your own accounts, budgeted

Transient refusals are waited out, an approaching weekly limit is
forecast so the operator can decide whether to pause or move work, and
every scripted run goes through the operator's budgeted accounts. Each
account is used for its owner's own work. Nothing here adds capacity or
hides usage; work moves to another of the operator's own accounts only
when one is at its threshold. Journey:
[your own accounts, budgeted](cujs/aleph-04-no-dead-jobs.md).

### Coordinators rotate cleanly

A coordinator can hand off to a fresh session from a checkpoint without
re-deriving state. Journey:
[rotate a coordinator from a checkpoint](cujs/aleph-05-coordinator-rotation.md).

### The fork stays current and safe (supporting)

One operator approval per upstream release, Aleph builds that know they're
Aleph, and remote access that survives every switch. Journeys:
[update to a new upstream release](cujs/aleph-07-upstream-update.md) and
[reach the server remotely across an upgrade](cujs/aleph-08-remote-access-across-upgrade.md).

### The diff gets smaller

Pieces that help other bb users (candidates today: `bb pool exec`,
thread-bound availability, provider icons) are offered upstream when the
maintainers want them. Success is a shorter
`git log --no-merges <upstream main>..HEAD`, not a longer feature list.

## Relationship to upstream bb

- Aleph follows upstream. It isn't a competing product or a distribution.
- Aleph keeps bb's package and command names, so merges stay clean and
  bb's documentation still applies.
- Upstream's direction wins. When upstream ships its own answer to a
  problem Aleph patched, Aleph adopts it and drops the patch.
- Aleph follows upstream's rules for contributions, including CLI parity
  and the plugin API conventions, so patches stay upstreamable.

## Not goals

- A general agent framework, or orchestration outside bb.
- Publishing Aleph or distributing it to other users.
- Saving tokens at the cost of quality. The quality bar comes first.

## How we'll know

These targets are aspirational; the baseline hasn't been measured yet.

- Coordinator wakes per completed child fall to about one.
- No coordinator wait runs past its deadline without becoming BLOCKED.
- No change needs more than two review rounds before a human decision.
- No scripted job dies on a refusal without waiting, pausing or asking the
  operator first.
- Usage per accepted outcome goes down release over release, and quality
  doesn't.
