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
| Outcome tag, inherited by child turns, pooled runs and receipts | **Planned** |
| Usage rolled up per accepted outcome, by kind, with a waste ratio | **Planned** |
| No-action wakes, retries, duplicate runs, over-cap review rounds and environment rebuilds recorded | **Planned** |

## What an outcome is

*Provisional, pending operator confirmation.*

- **Unit.** An outcome is a declared bb-native unit with an ID, a kind
  (`change`, `release`, `review`, `research` or `decision`), an acceptance
  test, and optionally an external reference (a tracker item or a pull
  request). The coordinator declares it at dispatch, and the operator can
  re-tag.
- **Inheritance.** Usage from every turn, child thread, pooled run and
  receipt inherits the outcome ID, the way ownership passes from parent to
  child. Untagged usage goes to an `unattributed` bucket.
- **Acceptance.** An outcome counts only when it's accepted on evidence: a
  merged SHA, a PASS verdict, a canary pass, or the operator's accept. The
  operator can override.
- **Waste.** An outcome that's abandoned or superseded counts entirely as
  waste. Within an outcome, no-action wakes, retries, duplicate runs,
  review rounds past the cap and environment-failure rebuilds count as
  waste too.
- **Cost unit.** Tokens, with cached and reasoning tokens shown
  separately, plus the percentage of the subscription window used.
  Dollars only for pay-per-token providers.
- **Headline.** Usage per accepted outcome, by kind, plus the waste ratio.

## The Journey

A coordinator starts budgeted work. For each run, it begins an attempt
with the receipts API. If receipts aren't available, begin returns 503
and the coordinator stops before spending. Otherwise the run completes
and the attempt is finalized. The result is a sealed record of every
upstream request and account hop, with the account, model and usage.

*Planned:* the coordinator declares an outcome when it dispatches work,
and every turn, child, pooled run and receipt under it carries the
outcome ID. bb records the waste counters for that outcome as it goes.

*Planned:* the operator opens a view, or runs a `bb` command, that lists
recent outcomes by kind with their usage by provider and model, their
waste counters, whether they were accepted and on what evidence, and the
size of the `unattributed` bucket. They can see that a
feature cost this much, that review took this share, and that this many
wakes were empty. The next release of Aleph can then be judged by whether
those numbers fell without quality falling.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Budget stops before spend | measurable | active | Receipt begin returning 503 → no provider process starts |
| Every budgeted run has a receipt | measurable | planned | Live canary: a finalized receipt names account, model and usage for a real run |
| Usage attributed to outcomes | measurable | planned | `unattributed` holds ≤ 10% of a week's usage |
| Tags are inherited | measurable | planned | A child thread, pooled run or receipt started under an outcome carries its ID without the child setting it |
| Acceptance needs evidence | observable | planned | Every accepted outcome names its merged SHA, PASS verdict, canary pass or operator accept |
| Waste is counted | measurable | planned | Each outcome shows no-action wakes, retries, duplicate runs, over-cap review rounds and environment rebuilds; abandoned and superseded outcomes count fully as waste |
| Headline is visible | observable | planned | Usage per accepted outcome, by kind, and the waste ratio can be compared between Aleph releases |
| Numbers change decisions | qualitative | planned | The operator uses the view to change a routing, review or dispatch rule |

## Known Friction Points

- **Receipts cover budgeted dispatch only.** Ordinary thread turns don't
  yet produce receipts, so coverage is partial.
- **Outcomes aren't a bb concept yet.** The definition above is
  provisional, and the tag needs new fields in bb.
- **Subscription-window share is approximate.** It comes from quota
  snapshots, which lag behind real usage.
- **Unknown usage must stay unknown.** Quota snapshots can't prove what a
  run used. Missing data is shown as missing, not estimated.
