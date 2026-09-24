# Aleph backlog

**Companion to:** [aleph-roadmap.md](aleph-roadmap.md)
**Last reviewed:** 2026-09-24

This file is maintained by hand. Items are ranked by expected usage saved
or quality gained, judged from the [observed waste](aleph-vision.md#where-the-usage-went).
None of these estimates has been measured yet, which is why the first item
is a baseline. Each item gives one line on why and links to the journey or
vision section it serves. Items marked *building block* extend something
`0.43.4+aleph.1` already ships. Everything else is new work.

## P0: largest savings, or protects everything else

- **Waste baseline and live receipt canary.** *Building block: attempt
  receipts.* Without numbers, no other item can show that it saved
  anything.
  → [Usage per outcome](cujs/aleph-06-usage-per-outcome.md)
- **Structural DONE/BLOCKED-only wakes.** The most frequent waste: one
  test run caused 5–6 empty coordinator wakes, and every child of every
  project pays this.
  → [Multi-day project](cujs/aleph-01-multi-day-coordinator.md)
- **Wait out transient "no eligible account" refusals.** *Building block:
  Account Pooler.* A 429 killed two review threads. Each dead thread loses
  everything it had spent.
  → [No dead jobs](cujs/aleph-04-no-dead-jobs.md)
- **Stop the in-app update prompt from installing plain upstream over
  Aleph.** One click removes every building block at once.
  → [Upstream update](cujs/aleph-07-upstream-update.md)

## P1: large savings or quality gains

- **Waits on outcomes, with deadlines that become BLOCKED.** One wait on
  the wrong condition cost about 7 hours and a maintenance window.
  → [Multi-day project](cujs/aleph-01-multi-day-coordinator.md)
- **Enforced review bounds: pinned commit, two rounds, then the
  operator.** *Building block: thread-bound availability.* One change took
  four rounds, and other reviews ran on a moving target or were re-run
  after routing changed.
  → [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md)
- **Capped, structured child returns.** Long returns fill the
  coordinator's context, which is the scarcest resource over a multi-day
  project.
  → [Structured results](cujs/aleph-02-structured-child-results.md)
- **Usage per outcome view.** *Building block: attempt receipts.* Turns
  the baseline into something the operator can act on each week.
  → [Usage per outcome](cujs/aleph-06-usage-per-outcome.md)
- **Coordinator checkpoints, checked against live state.** *Building
  block: switch-in-place.* Rotation now costs a re-derivation and risks
  acting on a stale handoff.
  → [Rotation](cujs/aleph-05-coordinator-rotation.md)
- **Live Codex `bb pool exec` canary; confirm the pooled Claude
  config-directory fix at the next switch.** *Building block: `bb pool
  exec`.* Both are carried but not yet verified with real runs.
  → [No dead jobs](cujs/aleph-04-no-dead-jobs.md)

## P2: moderate savings, or keeps the fork cheap

- **Classify failures as environment or real, with a preflight before
  expensive verification.** Environment failures each cost a full rebuild
  cycle before the real result.
  → [Structured results](cujs/aleph-02-structured-child-results.md)
- **Capacity forecast and proposed reroutes.** A provider-wide weekly
  cliff killed a producer mid-task. Seeing it coming lets work move first.
  → [No dead jobs](cujs/aleph-04-no-dead-jobs.md)
- **Update automation: range and overlap report, merge-and-qualify,
  switch runbook with a remote-access canary.** Hand merging is what makes
  a fork fall behind, and the building blocks go with it.
  → [Upstream update](cujs/aleph-07-upstream-update.md),
  [remote access](cujs/aleph-08-remote-access-across-upgrade.md)
- **Teach `bump-version` build metadata, and order Aleph builds in update
  checks.** `+aleph.2` is refused today and isn't offered over `+aleph.1`.
  → [Upstream update](cujs/aleph-07-upstream-update.md)
- **Enforced read-only reviewer runs.** Quality: a reviewer that can edit
  isn't independent.
  → [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md)

## P3: smaller or longer-term

- **Model choice per task class, tuned from outcome data.** Potentially
  large, but it depends on the usage-per-outcome data existing first.
  → [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md)
- **Stop runs by ID only.** A pattern-matched stop command killed a fresh
  review; thread-level stops already exist upstream.
  → [Cheapest adequate model](cujs/aleph-03-cheapest-adequate-model.md)
- **CLI surface for switch-in-place.** Coordinators rotate and reroute
  through the CLI, not the model picker.
  → [Rotation](cujs/aleph-05-coordinator-rotation.md)
- **Show Aleph's changelog in What's New.** The operator sees upstream's
  notes and not what Aleph changed.
  → [Vision: the fork stays current](aleph-vision.md#the-fork-stays-current-and-safe-supporting)
- **Offer building blocks upstream** (`bb pool exec`, thread-bound
  availability, provider icons) when maintainers want them. Shrinks the
  fork's diff.
  → [Vision: the diff gets smaller](aleph-vision.md#the-diff-gets-smaller)
- **Revise personas and journeys with the operator.** The first drafts
  come from operating notes, not structured sessions.
  → [Personas](aleph-personas.md)
