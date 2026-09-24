---
artifact_type: cuj
journey: usage-per-outcome
actor: solo operator (reads), coordinator agent (records)
criticality: p1
---

# The operator sees usage per outcome

## Why This Journey Matters

Every other journey claims to save usage or improve quality. Without
measurement, those claims can't be checked, and waste stays invisible
until a weekly limit runs out early. The operator needs to see what a
finished outcome cost (a merged change, a review, a release), and where
usage went that produced nothing: wakes with no action, retries, duplicate
or orphaned runs, extra review rounds.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Attempt receipts: sealed record of account, model and usage for one budgeted run | **Shipped** |
| Receipt begin returns 503 when receipts can't be issued, before spend | **Shipped** |
| Pool and account usage views | **Shipped** (upstream Provider Usage) |
| Live receipt canary | **Planned** (deferred: no provider capacity) |
| Usage rolled up per task or outcome | **Planned** |
| Wakes per task, retries, review rounds, duplicate runs recorded | **Planned** |

## The Journey

A coordinator starts budgeted work. For each run, it begins an attempt
with the receipts API. If receipts aren't available, begin returns 503
and the coordinator stops before spending. Otherwise the run completes
and the attempt is finalized. The result is a sealed record of every
upstream request and account hop, with the account, model and usage.

*Planned:* each receipt is tagged with the task or outcome it served.
bb also records the waste counters for that outcome: coordinator wakes,
retries, review rounds, and runs that were duplicated or abandoned.

*Planned:* the operator opens a view, or runs a `bb` command, that lists
recent outcomes with their total usage by provider and model, their waste
counters, and whether the outcome was accepted. They can see that a
feature cost this much, that review took this share, and that this many
wakes were empty. The next release of Aleph can then be judged by whether
those numbers fell without quality falling.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Budget stops before spend | measurable | active | Receipt begin returning 503 → no provider process starts |
| Every budgeted run has a receipt | measurable | planned | Live canary: a finalized receipt names account, model and usage for a real run |
| Usage attributed to outcomes | measurable | planned | ≥ 90% of pooled usage in a week is attributed to a named task or outcome |
| Waste is counted | measurable | planned | Each outcome shows wakes, retries, review rounds and duplicate runs |
| Trend is visible | observable | planned | Usage per accepted outcome can be compared between Aleph releases |
| Numbers change decisions | qualitative | planned | The operator uses the view to change a routing, review or dispatch rule |

## Known Friction Points

- **Receipts cover budgeted dispatch only.** Ordinary thread turns don't
  yet produce receipts, so coverage is partial.
- **Outcomes aren't a bb concept yet.** Tagging usage with a task needs a
  convention or a new field.
- **Unknown usage must stay unknown.** Quota snapshots can't prove what a
  run used. Missing data is shown as missing, not estimated.
