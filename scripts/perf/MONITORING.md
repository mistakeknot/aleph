# Proposed perf monitoring (not enabled)

Nothing here is scheduled. It describes what to wire into zklw automation
(independent CI, not GitHub Actions) if the owners approve.

1. Per-build smoke: `pnpm perf --runs 3 --reps 3 --only server,cmdk,switch --thresholds scripts/perf/thresholds.json`
   on a dedicated, otherwise idle runner. ~6 minutes. Thresholds for scenarios
   that `--only` did not select are skipped (the run prints how many), so this
   selection can pass; a selected scenario's metric with no samples, or with
   fewer samples than were requested, still fails. Fails the check on any
   `budget-*`, `missing` or `incomplete` failure.
2. Nightly: `pnpm perf --runs 7 --reps 5 --label nightly --baseline <last-green nightly json> --thresholds scripts/perf/thresholds.json`.
   Regression rule: a metric fails when its p50 or p95 grew by more than
   `regressionPct` and `regressionMinMs` versus the baseline. Keep the JSON
   as an artifact and trend `summary[*].p50`.
3. Runner hygiene: record `loadAtStart`; discard and rerun a nightly whose load
   average exceeded 4 (the seeded baseline was taken at load 17-65 on a shared
   host and has 40-100% coefficient of variation on browser metrics, so it
   cannot gate builds until measured on a quiet runner).
4. Server-only metrics (`server.*`) are the best candidates to gate first, but
   the 2026-09-30 baseline does not show they are stable: at load 17-65 their
   coefficient of variation was 40-900% (for example `server.timeline-small_ms`
   p50 6.7 ms against p95 225.4 ms). Decide what to gate only after measuring
   on a quiet runner; start every metric as advisory until then.

## Corrections to earlier perf claims (2026-09-30)

The commits that introduced the harness and the keystroke budget are not
rewritten. Read them with these corrections.

- **Which build was "before".** The pre-fix build for the debounce change is
  `79d6ff83b`. `92ca3fc6a` already contains the fix (`d93ea9615`), so an A/B
  that used `92ca3fc6a` as the baseline compared two builds with the same
  debounce.
- **What 177.7 -> 86.5 ms measures.** The `cmdk.keystroke_result_ms` figures in
  `d93ea9615` are follow-up keystrokes after the first searchable input, where
  the 150 ms debounce became 60 ms. They are not first-search latency; the
  first searchable input now fires immediately and was not measured separately.
- **The raw A/B data is gone.** The A/B result JSONs were deleted, and the
  percentiles in that commit message came from a different method than
  `percentile` in `lib.mjs` (interpolated over pooled samples), so the 177.7,
  197.6, 86.5 and 109.6 ms figures cannot be regenerated or audited from the
  repository. The A/B was not re-run for this correction because the shared
  host was at load average 48-71 on 32 cores, which this document says makes
  comparisons unreliable. Re-run it on a quiet host and keep the raw JSON
  before relying on the number.
- **`server.search-1/2/3_ms` are not 1, 2 and 3 characters.** The scenario
  requests the first three seeded multi-word queries (`meta.queries`), one per
  metric. The names are kept so the baseline and thresholds stay comparable;
  read them as "search query 1/2/3".
- **The baseline's switch sample counts.** `switch.cmdk_enter_ms` and
  `switch.sidebar_click_ms` have 20 samples where 25 were requested (4 of 5
  per run). The baseline came from an uncommitted harness (`32805d83a`, dirty),
  so the cause of each shortfall cannot be confirmed from it. With the current
  harness, palette-switch iteration 0 pressed Enter on a "Show more" row, which
  does not navigate, and the timed-out sample was silently dropped. That is
  fixed, and the harness now records every missing sample and fails the run. A
  sidebar-click shortfall did not reproduce (10 of 10 samples).
- **Search completion was looser than it looked.** `probe.js` `searchDone`
  accepted any completed request for the query, including one that finished
  before the measurement started. It now requires a successful request that
  started after the measurement, and a result served from the cache is recorded
  as a failed sample instead of a timing. This makes the probe stricter; it does
  not show that the earlier A/B was affected.
