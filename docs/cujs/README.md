# Aleph critical user journeys

Each journey describes an experience Aleph must support well, with typed
success signals (`measurable`, `observable`, `qualitative`) and a status for
each signal (`active` or `planned`). The actors are described in
[personas](../personas.md). These are first drafts written from operating
experience. They'll be revised after working sessions with the operator.

| # | Journey | Actor | Criticality |
|---|---|---|---|
| 01 | [Update Aleph to a new upstream release](aleph-01-upstream-update.md) | Operator, coordinator agent | p0 |
| 02 | [Run many agents on pooled accounts](aleph-02-pooled-agent-runs.md) | Coordinator agent, scheduled job, worker agent | p0 |
| 03 | [Coordinate child threads cheaply](aleph-03-child-thread-reporting.md) | Coordinator agent | p1 |
| 04 | [Borrow the other provider for an independent review](aleph-04-cross-provider-review.md) | Coordinator agent, reviewer agent | p1 |
| 05 | [Switch a thread's provider in place](aleph-05-provider-switch-in-place.md) | Operator | p2 |
| 06 | [Reach the server remotely across an upgrade](aleph-06-remote-access-across-upgrade.md) | Operator | p1 |

Criticality: p0 means Aleph fails its [mission](../../MISSION.md) if this
journey breaks. p1 means a core workflow is degraded. p2 means friction the
operator notices every day.
