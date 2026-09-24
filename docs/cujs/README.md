# Aleph critical user journeys

Each journey describes an experience Aleph must support well, with typed
success signals (`measurable`, `observable`, `qualitative`) and a status for
each signal (`active` or `planned`). The actors are described in
[personas](../aleph-personas.md). Journeys 01–06 serve the
[mission](../../MISSION.md) directly: usage spent on project progress.
Journeys 07–08 support them by keeping the fork current and reachable.

These are first drafts written from operating experience. They'll be revised
after working sessions with the operator.

| # | Journey | Actor | Criticality |
|---|---|---|---|
| 01 | [Run a multi-day project without wake storms](aleph-01-multi-day-coordinator.md) | Coordinator agent, operator | p0 |
| 02 | [Children return capped, structured results](aleph-02-structured-child-results.md) | Worker/reviewer agent, coordinator agent | p1 |
| 03 | [Route work to the cheapest adequate model, with bounded cross-provider review](aleph-03-cheapest-adequate-model.md) | Coordinator agent, reviewer agent | p1 |
| 04 | [No job dies on one exhausted account](aleph-04-no-dead-jobs.md) | Coordinator agent, scheduled job, worker agent, operator | p0 |
| 05 | [Rotate a coordinator cleanly from a checkpoint](aleph-05-coordinator-rotation.md) | Coordinator agent, operator | p1 |
| 06 | [The operator sees usage per outcome](aleph-06-usage-per-outcome.md) | Operator, coordinator agent | p1 |
| 07 | [Update Aleph to a new upstream release](aleph-07-upstream-update.md) *(supporting)* | Operator, coordinator agent | p1 |
| 08 | [Reach the server remotely across an upgrade](aleph-08-remote-access-across-upgrade.md) *(supporting)* | Operator | p1 |

Criticality: p0 means the mission fails if this journey breaks, because
usage is lost at scale. p1 means a core workflow is degraded or waste goes
unseen.
