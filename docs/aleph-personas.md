# Aleph personas

> Who Aleph is for, and where their usage goes today.

Aleph has three users: one human and two kinds of agent. The coordinator
agent is at the center, since that's where orchestration succeeds or wastes
usage. These personas come from real operation. They haven't been tested with
a wider group of users.

## 1. The coordinator agent

**Who.** A long-lived agent thread that runs a project for hours or days.
It plans, starts child threads for implementation and review, waits for
them, checks their evidence, and passes decisions to the operator. It
works through bb's threads and CLI.

**Goals**
- Keep the project moving with as few of its own turns as possible.
- Hear from children only when they're DONE, BLOCKED or need a decision.
- Send each piece of work to the cheapest model that can do it well, and
  get an independent review when it matters.
- Survive its own context limits by rotating from a checkpoint.

**Frustrations**
- Woken 5–6 times by a single child's progress updates during one test
  run, with nothing to act on.
- A wait on the wrong condition (a process exit) never ended, and hours
  were lost.
- Reviews ran against a moving branch, looped for four rounds, or had to
  be redone after routing rules changed underneath them.
- A child died on a transient "no eligible account" refusal, or when every
  account for one provider ran out at once.
- After compaction or rotation, it re-derives state and sometimes trusts a
  stale handoff.

**Context.** Its budget is its own context and tokens. Every message it
reads costs both. It reads structured output better than prose, and it has
to be able to prove what it did.

**Success looks like:** a multi-day project where it wakes about once per
finished child, every child's return fits one screen, no child dies on
capacity, and rotation starts from a checkpoint in one turn.

## 2. The solo operator

**Who.** One technical person running several projects through
coordinator threads across a server and a laptop. They mostly reach the
server from a browser somewhere else. They hold several subscription
accounts per provider and pay for all of them.

**Goals**
- Turn their accounts' usage into finished, reviewed work.
- Make decisions when a coordinator brings one, and otherwise stay out of
  the way.
- See what each outcome cost, and where usage went that didn't produce
  anything.
- Get upstream bb improvements without losing anything they rely on.

**Frustrations**
- Status-only messages from coordinators that need no decision.
- Weekly limits reached early because of wasted wakes and repeated
  reviews.
- A project stalled for hours because a wait never ended and nobody
  noticed.
- No way to say "that feature cost this much".

**Context.** Works in short sessions, often from a phone. Treats the
server as production. Sets the rules (return shape, review cap, silence
when nothing is new) and currently has to put them in every prompt.

**Success looks like:** each week, more accepted outcomes for the same
usage, a short list of decisions to make, and no surprises.

## 3. The worker or reviewer agent

**Who.** A short-lived child thread or scripted run that implements or
reviews one bounded piece of work. It may use the other provider's model
so the review is independent.

**Goals**
- Get capacity when it starts, and survive transient refusals.
- Know the end state, the target commit and the round limit.
- Return once, with a capped, structured result.

**Frustrations**
- Killed by a transient account refusal partway through.
- Reviewing a branch that changed underneath it.
- Stopped by a command that matched the wrong process.
- Build checks failing on environment problems before it gets a real
  answer.

**Context.** Runs once and exits. Its output is read by a coordinator,
not a person.

**Success looks like:** it starts on pooled capacity, works on a fixed
target, and ends with one message: `DONE` or `BLOCKED`, evidence, and
whether any failure was real or came from the environment.

## Waste by persona

| Waste pattern | Coordinator | Operator | Worker/reviewer | Journey |
|---|---|---|---|---|
| Wake storms, status churn | ● | ● | | [01 multi-day project](cujs/aleph-01-multi-day-coordinator.md) |
| Wrong wait conditions | ● | ● | | [01 multi-day project](cujs/aleph-01-multi-day-coordinator.md) |
| Long or unstructured returns, environment failures | ● | | ● | [02 structured results](cujs/aleph-02-structured-child-results.md) |
| Unbounded or mis-targeted review | ● | ● | ● | [03 cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md) |
| Capacity cliffs, transient refusals | ● | ● | ● | [04 no dead jobs](cujs/aleph-04-no-dead-jobs.md) |
| Context-heavy coordinators | ● | | | [05 rotation](cujs/aleph-05-coordinator-rotation.md) |
| Unmeasured usage | | ● | | [06 usage per outcome](cujs/aleph-06-usage-per-outcome.md) |
