# Aleph personas

> Who Aleph is for, and what gets in their way today.

Aleph has three users: one human and two kinds of agent. These personas come
from how the fork is actually run. They haven't been tested against a wider
group of users, and Aleph doesn't aim to serve one.

## 1. The solo operator

**Who.** One technical person running many agent threads across two
machines: a dev server where the work happens and a laptop. They mostly reach
the server from a browser somewhere else, through bb's hosted connect
service. They have several subscription accounts per provider.

**Goals**
- Keep plenty of agent work running without watching it.
- Get upstream bb improvements soon after they ship.
- Know what ran, on which account and model, at what cost.
- Make the decisions, and leave the supervising to others.

**Frustrations**
- An upgrade erased local changes, and each upgrade needed hand work.
- Jobs failed on exhausted logins while other accounts still had capacity.
- A change to remote pairing could have locked them out of their own
  server.
- Small UI friction repeats hundreds of times a day: telling providers apart
  in a long thread list, or switching providers without losing the thread's
  title, pin, place and children.

**Context.** Works in short sessions, often on a phone or a laptop away from
the server. Approves decisions that coordinator threads bring to them.
Treats the server as production: its data and running threads matter.

**Success looks like:** an upstream release reaches them as a ready,
qualified change that needs one approval. They take it and nothing they rely
on breaks.

## 2. The coordinator agent

**Who.** A long-lived agent thread that plans work, starts child threads,
passes decisions to the operator, and reports results. It works in bb's
threads and CLI, not the UI.

**Goals**
- Dispatch work to children and learn quickly when each one is done or
  stuck.
- Stay within its context window and token budget over a long session.
- Use safe, scriptable primitives: pooled runs, receipts, thread
  availability checks.

**Frustrations**
- Every child turn wakes the coordinator and costs tokens, including turns
  that only report progress.
- Plain CLI launches skip the pool, so dispatched jobs fail on exhausted
  accounts.
- Pool-wide flags can't say whether a particular thread may borrow the other
  provider.

**Context.** Its budget is its own context and tokens. It reads structured
output better than prose. It has to be able to prove what it did to the
operator.

**Success looks like:** it's woken only when a child finishes or is blocked,
each run it starts reports its account and model, and it never has to guess
whether a run used the pool.

## 3. The worker or reviewer agent

**Who.** A short-lived child thread or scripted run that implements a change
or reviews one, sometimes with the other provider's model so the review is
independent.

**Goals**
- Get capacity when it starts, without handling credentials.
- Know when to stop, and report DONE or BLOCKED clearly.
- As a reviewer, be sure it can't change what it's reviewing.

**Frustrations**
- Launching failed because the account it happened to get was exhausted.
- Settings from the calling folder leaked into a pooled Claude run.
- Nothing told it whether the run was really pooled or fell back to
  something else.

**Context.** Runs once and exits. It may run as a scheduled job with no
thread around it. Its output is read by a coordinator, not by a person.

**Success looks like:** it starts on a pooled account, runs with the
provider settings the host chose, finishes its job, and ends with one clear
status line.

## Pain points by source

| Pain | Operator | Coordinator | Worker/reviewer | Addressed by |
|---|---|---|---|---|
| Upgrades erase local changes | ● | | | [upstream update](cujs/aleph-01-upstream-update.md) |
| Exhausted logins while pool has headroom | ● | ● | ● | [pooled runs](cujs/aleph-02-pooled-agent-runs.md) |
| Progress chatter costs tokens | | ● | | [child reporting](cujs/aleph-03-child-thread-reporting.md) |
| Unclear permission to borrow the other provider | | ● | ● | [cross-provider review](cujs/aleph-04-cross-provider-review.md) |
| Switching provider loses the thread's place | ● | | | [switch in place](cujs/aleph-05-provider-switch-in-place.md) |
| Remote access at risk on upgrade | ● | | | [remote access](cujs/aleph-06-remote-access-across-upgrade.md) |
