# Aleph — Vision

**Version:** 0.1
**Date:** 2026-09-24
**Status:** Draft

[Mission](../MISSION.md) · [Philosophy](../PHILOSOPHY.md) ·
[Personas](personas.md) · [Journeys](cujs/README.md) ·
[Roadmap](aleph-roadmap.md) · [Backlog](backlog.md)

---

## The idea

bb is a programmable workspace for coding agents. Aleph is the version of it
that one operator runs every day: many agent threads across a server and a
laptop, most of them reached through a browser from somewhere else, and many
of them started and supervised by other agents.

Almost everything Aleph needs comes from upstream bb. Aleph exists for the few
things one operator needs before upstream has them, and it's measured by how
small and how current it stays.

## Why a fork, and not only plugins

Aleph started because of four problems that came up in real operation:

1. **Upgrades erased local changes.** A hand-applied bb upgrade removed the
   operator's UI patches. A reapply-only patch tool helped, but every upgrade
   still needed a person.
2. **Capacity ran out unevenly.** The operator has several subscription
   accounts per provider, each hitting its limits at different times.
   Scripted jobs launched the provider CLI directly, bypassed the pool, and
   failed on exhausted logins while other accounts still had headroom.
3. **Borrowing and spend weren't accountable.** A thread sometimes needs the
   other provider, for example for an independent review from another lab.
   Pool-wide switches couldn't say whether *this* thread was allowed to
   borrow, and budgeted runs had no record of which account and model ran.
4. **Remote access was fragile across upgrades.** An upstream change moved
   remote pairing into a new plugin and was later reverted after a production
   incident. For an operator who works remotely, that change could have cut
   off access.

Some of these needed changes in core or in bundled plugins, which is why
Aleph is a fork. The [philosophy](../PHILOSOPHY.md) keeps the fork thin.

## Where Aleph is now

`0.43.4+aleph.1` is upstream bb 0.43.4 plus upstream main through `fdd3de3`,
with these carried patches ([FORK.md](../FORK.md) has the details):

- Account Pooler 0.1.2: thread-bound availability, `bb pool exec` for Codex
  and Claude, attempt receipts for budgeted dispatch, and pooled Claude runs
  isolated from the calling folder's settings.
- Provider icons in the thread list, with color modes.
- Switching a thread's provider in place from the model picker, when the
  handoff plugin is running.
- Optional composer focus on keyboard pane switches.
- A credential-free release check that the fork's CI runs on fresh machines.

Updates are still done by hand. Two live canaries (a Codex run through
`bb pool exec` and a live receipt) are deferred because provider capacity
wasn't available.

## Where Aleph is going (next 6–12 months)

These are goals, not shipped features. The [roadmap](aleph-roadmap.md)
orders them.

### Taking upstream releases becomes routine

One operator approval per upstream release. Scripts compute the upstream
range and its overlap with carried patches, merge and qualify, then prepare
a switch that drains work, snapshots data, installs, runs a canary and can
roll back. Journey: [update Aleph to a new upstream release](cujs/aleph-01-upstream-update.md).

### Aleph knows it's Aleph

Update checks order Aleph builds correctly, so `+aleph.2` is offered over
`+aleph.1`. The in-app update prompt no longer installs plain upstream over
Aleph and offers to merge the release into Aleph instead. What's New shows
Aleph's changelog as well as upstream's.

### Capacity is pooled, fenced and accounted for

Every scripted or supervised agent run goes through the pool, and each one
reports whether it really ran pooled. Borrowing another provider's pool is
decided per thread. Budgeted runs carry receipts and stop when usage can't
be accounted for. The deferred live canaries pass. Journeys:
[pooled runs](cujs/aleph-02-pooled-agent-runs.md) and
[cross-provider review](cujs/aleph-04-cross-provider-review.md).

### Coordinators pay only for signals they need

A coordinator thread hears from a child when the child finishes or is
blocked, not on every turn. Progress is coalesced or left out. Journey:
[coordinate child threads](cujs/aleph-03-child-thread-reporting.md).

### Remote access survives every upgrade

Qualification includes the remote path. An upgrade that would change
pairing or connect behavior is caught before the switch, not after the
operator is locked out. Journey:
[reach the server remotely across an upgrade](cujs/aleph-06-remote-access-across-upgrade.md).

### The diff gets smaller

Carried patches that are useful beyond this operator (provider icons,
`bb pool exec`, thread-bound availability are the current candidates) are
offered upstream when the maintainers want them. Success is a shorter
`git log --no-merges <upstream main>..HEAD`, not a longer feature list.

## Relationship to upstream bb

- Aleph follows upstream. It doesn't compete with bb or make promises for
  it, and it isn't a general distribution.
- Aleph keeps bb's package and command names, so merges stay clean and
  bb's documentation still applies.
- Upstream's direction wins. When upstream ships its own answer to a
  problem Aleph patched, Aleph adopts it and drops the patch, even if the
  patch worked.
- Aleph follows upstream's contribution rules, including CLI parity for
  every feature and the plugin API conventions. That keeps patches
  upstreamable.

## Not goals

- A second product line with its own features or roadmap separate from bb.
- Publishing Aleph to npm or distributing it to other users.
- Keeping a patch after upstream has solved the problem another way.

## How we'll know

These targets are aspirational; none of them has been measured yet.

- Taking an upstream release needs one operator decision and no hand
  merging when there are no conflicts with carried patches.
- No scripted agent job fails on an exhausted login while another pooled
  account has headroom.
- Across upgrades, the operator never loses remote access or local changes.
- The number of carried patches goes down over time.
