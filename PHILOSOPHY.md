# Aleph philosophy

How Aleph is built and run. [MISSION.md](MISSION.md) says why it exists;
where the two disagree, the mission wins.

The principles come from watching coordinator sessions waste usage in
specific ways. The [vision](docs/aleph-vision.md#where-the-usage-went) lists
those cases. Each principle below answers at least one of them.

## Spending usage well

### 1. Every token should move a project forward

The unit that matters is usage per outcome, not usage per turn. A wake
that brings nothing actionable, a review repeated because its target moved,
or a rebuild caused by the environment all cost as much as useful work.
Aleph counts them as waste and tries to make them impossible, not just
discouraged.

### 2. Silence is the default; wake a coordinator only for news

A coordinator should be woken for three things: a child is DONE, a child
is BLOCKED, or a decision is needed. Progress updates, status relays
between coordinators and "still working" messages cost the coordinator
tokens and context without changing what it does next. When nothing is
new, a coordinator ends its turn without speaking.

### 3. Wait on outcomes, with a deadline

Waiting on a stand-in for an outcome, such as a process exiting, can go
wrong without anyone noticing: the process lingers and the wait never
ends. Wait on the thing that matters (a thread status, a commit, a check
result) and give every wait a deadline that turns into BLOCKED.

### 4. Cheapest adequate model first; independent review when it matters

Set the quality bar first, then use the cheapest model that clears it.
When independence matters, review with the other provider's model. The
thread must be allowed to borrow it, and the review has a fixed target
commit and a fixed number of rounds (two by default). After that, the
disagreement goes to the operator.

### 5. Capacity is a pool, not a login

Accounts for several providers hit their limits at different times, and
sometimes all at once. Work should draw from the pool, wait out transient
refusals instead of dying, and surface a provider-wide cliff early enough
to reroute. No job should fail on one exhausted account while another has
headroom.

### 6. Fail closed on credentials and accounting

When Aleph can't tell whether something is allowed or what it will cost,
it refuses. If ownership can't be checked, the answer is 503, not
permission. A run whose pooled route is unconfirmed is never replayed. A
budgeted run that can't get a receipt stops before it spends quota.
Credentials stay in the child process environment and never appear in
arguments, files or logs.

### 7. Coordinators are finite; state lives outside them

Long sessions fill their context and eventually compact, rotate or
restart. Each time, the next session should be able to start from a
checkpoint (goals, decisions, open work, evidence) without re-deriving
state or trusting a stale handoff. If a fact matters, it lives in an
artifact, not only in a transcript.

### 8. Returns are capped and structured

A child's final message is the coordinator's input. It should have a
fixed shape (status, evidence, the next decision) and a size limit, and
it should say whether a failure was real or came from the environment.

### 9. Measure the waste

Wakes per task, retries, duplicate or orphaned runs, review rounds, and
usage per outcome. Without these numbers, "more efficient" can't be
tested. Receipts, which record the account, model and usage of each
budgeted run, are the first building block.

## Keeping the fork useful

These are means, not the mission. They keep the orchestration layer
current and safe to change.

### 10. Upstream is the source of truth; carry patches narrowly

Aleph is a named layer on bb. Every version names its upstream base
(`0.43.4+aleph.1` is upstream 0.43.4 plus main through a named commit).
Upstream is merged in, not rebased, and each merge records its conflicts.
Prefer a plugin or setting to a core edit. Each patch ends one of three
ways: upstream takes it when the maintainers want it, upstream solves the
problem another way, or it's retired.

### 11. Staying current has to be cheap, and switches must be reversible

The target is one operator approval per upstream release. A release is
installed only after the fork's CI has passed twice on fresh machines at
the exact commit, and after an independent review. The switch drains
work, snapshots data, runs a canary and keeps a rollback ready. Evidence
is kept after the change lands.

### 12. Agents are users; decide what done means first

Coordinators and workers use Aleph mostly through the `bb` CLI, so every
feature works there as well as in the UI. Each piece of work starts with
its end state and the evidence that will prove it.

## Tradeoffs

- **Structure over flexibility in returns and waits.** Fixed return
  shapes, caps and deadlines sometimes cut off a useful long answer or
  end a wait that would have finished. Aleph accepts that cost; an
  unbounded wait or return costs more.
- **Bounded review over exhaustive review.** Two rounds and then a human
  will sometimes let a finding through that a fourth round would catch.
  The alternative has been seen to cost more than it found.
- **Aleph keeps bb's names.** Packages and commands are still `bb-app`
  and `bb`, so merges stay clean. Only the version and
  [FORK.md](FORK.md) identify the fork, and it can't be published to npm
  under the `bb-app` name.
- **Build metadata instead of a new version line.** `+aleph.<n>` keeps
  upstream releases visible in update checks, but Aleph builds on the
  same base don't sort against each other yet.
- **One operator's workload, not a distribution.** Aleph is shaped by one
  operator's projects. Where a change would help other bb users, it
  belongs upstream.
