# Aleph backlog

**Companion to:** [aleph-roadmap.md](aleph-roadmap.md)
**Last reviewed:** 2026-09-24

This file is maintained by hand. Each item gives one line on why it matters
and links to the [journey](cujs/README.md) or [vision](aleph-vision.md)
section it serves. P0 must be done before the next switch. P1 is needed for
routine updates. P2 improves daily work. P3 is when there's room.

## P0

- **Stop the in-app update prompt from installing plain upstream over
  Aleph.** One click on the upgrade prompt currently replaces the fork and
  its carried patches.
  → [Update journey](cujs/aleph-01-upstream-update.md),
  [vision: Aleph knows it's Aleph](aleph-vision.md#aleph-knows-its-aleph)
- **Confirm the pooled Claude config-directory fix at the next switch.** The
  fix is carried but hasn't been verified on the running server.
  → [Pooled runs](cujs/aleph-02-pooled-agent-runs.md)

## P1

- **Upstream range and overlap script.** Shows which upstream commits touch
  carried patches, connect or pairing before any merge starts.
  → [Update journey](cujs/aleph-01-upstream-update.md),
  [remote access](cujs/aleph-06-remote-access-across-upgrade.md)
- **Teach `bump-version` build metadata, and order Aleph builds in update
  checks.** `+aleph.2` is refused today and isn't offered over `+aleph.1`.
  → [Update journey](cujs/aleph-01-upstream-update.md)
- **Live Codex `bb pool exec` canary.** Codex through the pool is tested but
  hasn't been run live.
  → [Pooled runs](cujs/aleph-02-pooled-agent-runs.md)
- **Live attempt-receipt canary.** Budgeted dispatch depends on receipts
  that haven't been exercised with a real run.
  → [Pooled runs](cujs/aleph-02-pooled-agent-runs.md)
- **Merge-and-qualify pipeline.** Hand merging is the main cost of staying
  current.
  → [Update journey](cujs/aleph-01-upstream-update.md),
  [vision: routine updates](aleph-vision.md#taking-upstream-releases-becomes-routine)
- **Switch runbook script with a remote-access canary.** Draining,
  snapshotting and rollback are manual and easy to get wrong under time
  pressure.
  → [Update journey](cujs/aleph-01-upstream-update.md),
  [remote access](cujs/aleph-06-remote-access-across-upgrade.md)

## P2

- **DONE/BLOCKED child reporting as a feature.** Coordinators pay tokens for
  every child turn, and today only prompts prevent it.
  → [Child reporting](cujs/aleph-03-child-thread-reporting.md)
- **Show Aleph's changelog in What's New.** The operator sees upstream's
  notes and not what Aleph changed.
  → [Vision: Aleph knows it's Aleph](aleph-vision.md#aleph-knows-its-aleph)
- **Enforce read-only reviewer runs.** A reviewer is only told not to edit;
  nothing prevents it.
  → [Cross-provider review](cujs/aleph-04-cross-provider-review.md)
- **Check and add CLI parity for switch-in-place.** bb requires every
  feature to be usable from the CLI; this one hasn't been checked.
  → [Switch in place](cujs/aleph-05-provider-switch-in-place.md)

## P3

- **Offer provider icons upstream.** It's useful beyond this operator, and
  shrinks the fork's diff. Offer only if the maintainers want it.
  → [Vision: the diff gets smaller](aleph-vision.md#the-diff-gets-smaller)
- **Offer `bb pool exec` and thread-bound availability upstream.** These are
  the largest carried patches, and the costliest to keep merging.
  → [Vision: the diff gets smaller](aleph-vision.md#the-diff-gets-smaller)
- **Measure what coordinators spend on child updates.** Without a baseline,
  the reporting work can't show that it saves anything.
  → [Child reporting](cujs/aleph-03-child-thread-reporting.md)
- **Revise personas and journeys with the operator.** The first drafts come
  from operating notes, not from structured sessions.
  → [Personas](aleph-personas.md)
