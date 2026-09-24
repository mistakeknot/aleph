# Aleph philosophy

How Aleph is built and maintained. [MISSION.md](MISSION.md) says why it
exists; where the two disagree, the mission wins.

Aleph is a fork only because one operator needs some changes before upstream
has them. Each principle below keeps that reason small, so that it can be
checked and eventually removed.

## Principles

### 1. Upstream is the source of truth

bb is healthy and moves quickly. Aleph is a named layer on top of it and is
not a separate product. Every Aleph version names the upstream release and
commit it's built on (`0.43.4+aleph.1` is upstream 0.43.4 plus main through a
named commit). Upstream is merged in, not rebased, and each merge commit
records its conflicts. When upstream solves a problem Aleph patched, Aleph
takes upstream's solution and drops its own.

### 2. Carry patches narrowly, and give each one an exit

A carried patch needs a reason from real operation and the smallest diff that
answers it. Prefer a plugin or a setting to an edit in core, because bb is
designed so that users can adapt it without forking. Each patch ends in one of
three ways: upstream accepts it, upstream solves the problem another way, or
it's retired. Patches are offered upstream only when the maintainers want
them; Aleph doesn't push its needs onto upstream's roadmap.

### 3. Staying current has to be cheap

If taking an upstream release costs a day of hand merging, the operator
stops doing it and the fork falls behind. The target is one operator
approval per upstream release. Scripts compute the range and the overlap
with carried patches, merge, qualify and prepare the switch; the person
decides whether to go ahead. Until that tooling exists this is a goal, and
the [roadmap](docs/aleph-roadmap.md) tracks it.

### 4. Qualify before you switch

A release is not installed because it builds. It's installed after the
fork's CI has passed twice on fresh isolated machines without credentials,
at the exact source commit that will run, and after an independent review.
The switch itself drains running work, snapshots data, installs, runs a
canary and keeps a rollback ready.

### 5. Fail closed on credentials and accounting

When Aleph can't tell whether something is allowed, it refuses. If thread
ownership can't be checked, the answer is 503, not permission. A pooled run
whose route is unconfirmed is reported as such and never replayed. A
budgeted run that can't get a receipt stops before it spends quota. Nothing
widens a credential's reach to make a job work: tokens stay in the child
process environment and never appear in arguments, files or logs.

### 6. Keep everything reversible, with the evidence

Every switch has a snapshot and a rollback path taken before it starts.
Qualification results, receipts and merge conflict notes are kept after the
change lands, so that a later question ("which account ran this?", "what did
that merge change?") has an answer that doesn't depend on memory.

### 7. Agents are users too

Many of Aleph's users are agent threads: coordinators that plan and dispatch
work, and workers and reviewers that carry it out. For a coordinator, every
message costs tokens and context. Aleph designs structured, low-volume
signals for them (done, blocked, receipts, pooled-transport markers), and
every feature it adds works from the `bb` CLI as well as the UI.

### 8. Decide what done means first

Each piece of work starts with its end state and the evidence that will
prove it. Reviews have a fixed number of rounds, after which the remaining
disagreement goes to the operator.

## Tradeoffs

- **Aleph keeps bb's names.** Packages and commands are still `bb-app` and
  `bb`, so upstream merges stay clean and tooling keeps working. The cost is
  that only the version and [FORK.md](FORK.md) identify the fork, and Aleph
  can't be published to npm under the `bb-app` name.
- **Build metadata instead of a new version line.** `+aleph.<n>` keeps
  upstream releases visible in update checks. The cost is that Aleph builds
  on the same base don't sort against each other, and upstream's in-app
  update will offer to replace Aleph. Both are open work.
- **Merge, not rebase.** History is noisier, but each merge keeps its
  conflict record and the carried commits stay listable with
  `git log --no-merges <upstream main>..HEAD`.
- **One operator's needs, not a distribution.** Aleph is built for one
  operator's setup. Where a change would help other bb users, it belongs
  upstream.
