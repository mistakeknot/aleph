# Proposed perf monitoring (not enabled)

Nothing here is scheduled. It describes what to wire into zklw automation
(independent CI, not GitHub Actions) if the owners approve.

1. Per-build smoke: `pnpm perf --runs 3 --reps 3 --only server,cmdk,switch --thresholds scripts/perf/thresholds.json`
   on a dedicated, otherwise idle runner. ~6 minutes. Fails the check on any
   `budget-*` or `missing` failure.
2. Nightly: `pnpm perf --runs 7 --reps 5 --label nightly --baseline <last-green nightly json> --thresholds scripts/perf/thresholds.json`.
   Regression rule: a metric fails when its p50 or p95 grew by more than
   `regressionPct` and `regressionMinMs` versus the baseline. Keep the JSON
   as an artifact and trend `summary[*].p50`.
3. Runner hygiene: record `loadAtStart`; discard and rerun a nightly whose load
   average exceeded 4 (the seeded baseline was taken at load 17-65 on a shared
   host and has 40-100% coefficient of variation on browser metrics, so it
   cannot gate builds until measured on a quiet runner).
4. Server-only metrics (`server.*`) are stable enough to gate first; browser
   metrics should start as advisory.
