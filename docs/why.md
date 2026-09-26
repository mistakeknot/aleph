---
artifact_type: card
card_version: 1
project: aleph
status: provisional
confirmed_by: null
confirmed_at: null
line: "Coordinators burn usage waking for nothing"
fields:
  persona:
    state: drafted
    value: "Long-lived coordinator agent running a multi-day bb project across providers and accounts"
    evidence:
      - { path: "docs/aleph-personas.md:12", scope: project }
  pain:
    state: drafted
    value: "Coordinator sessions lose usage to wake storms, stuck waits, unbounded reviews, and jobs dying on an exhausted account instead of buying project progress"
    evidence:
      - { path: "MISSION.md:5", scope: project }
  cuj:
    state: drafted
    ref: null
    path: "docs/cujs/aleph-01-multi-day-coordinator.md"
    evidence:
      - { path: "docs/cujs/aleph-01-multi-day-coordinator.md:1", scope: journey }
  success:
    state: drafted
    value: "Coordinator wakes per completed child fall to about one (aspirational target; the repo notes the baseline is not yet measured)"
    evidence:
      - { path: "docs/aleph-vision.md:160", scope: project }
  guardrail:
    state: drafted
    value: "Usage per accepted outcome goes down release over release, and quality does not"
    evidence:
      - { path: "docs/aleph-vision.md:165", scope: project }
decisions: []
---

# Why Aleph

Aleph is mk's fork of bb, built to make long-running, multi-provider
coordinator sessions spend their usage on project progress instead of
losing it to wake storms, stuck waits, unbounded review loops, and jobs
that die on one exhausted account.

The coordinator agent — the long-lived thread that plans a project,
starts child threads, waits for them, and passes decisions to the
operator — is who this is for. In observed operation, a single child
caused 5-6 coordinator wakes with nothing actionable, and a wait on the
wrong condition (a process exit instead of a real outcome) stalled a
maintenance window for about 7 hours. Aleph's fork carries the
orchestration pieces bb doesn't have yet — pooled capacity, structured
returns, bounded review, receipts — to close that gap, and folds each
piece back upstream when it can.

The project's own stated yardstick is coordinator wakes per completed
child falling to about one, with usage per accepted outcome improving
release over release without quality getting worse. Both are aspirational
today: the repo is explicit that no baseline has been measured yet.
