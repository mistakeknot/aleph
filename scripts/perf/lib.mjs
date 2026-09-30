export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const rank = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (rank - lower)
  );
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function summarize(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { n: 0, min: null, p50: null, p95: null, max: null, mean: null, stdev: null, cv: null };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.length > 1
      ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (sorted.length - 1)
      : 0;
  const stdev = Math.sqrt(variance);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
    mean: round(mean),
    stdev: round(stdev),
    cv: mean === 0 ? 0 : round((stdev / mean) * 100),
  };
}

export class Recorder {
  constructor() {
    this.samples = {};
    this.expected = {};
    this.failures = {};
  }

  add(name, value, reason = "no value") {
    this.expected[name] = (this.expected[name] ?? 0) + 1;
    if (value === null || value === undefined || !Number.isFinite(value)) {
      this.fail(name, 1, reason, false);
      return;
    }
    (this.samples[name] ??= []).push(value);
  }

  missing(name, count, reason) {
    if (count <= 0) return;
    this.expected[name] = (this.expected[name] ?? 0) + count;
    this.fail(name, count, reason, false);
  }

  fail(name, count, reason, countExpected = true) {
    if (countExpected) {
      this.expected[name] = (this.expected[name] ?? 0) + count;
    }
    const entry = (this.failures[name] ??= { count: 0, reasons: [] });
    entry.count += count;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  }
}

export const SCENARIOS = [
  { name: "startup", prefixes: ["startup.", "startup_warm."], browser: true },
  { name: "cmdk", prefixes: ["cmdk."], browser: true },
  { name: "switch", prefixes: ["switch."], browser: true },
  { name: "thread", prefixes: ["thread_open."], browser: true },
  { name: "composer", prefixes: ["composer."], browser: true },
  { name: "server", prefixes: ["server."], browser: false },
];

export function scenarioOfMetric(name) {
  return (
    SCENARIOS.find((scenario) =>
      scenario.prefixes.some((prefix) => name.startsWith(prefix)),
    )?.name ?? null
  );
}

export function selectScenarios({ only, skipBrowser = false, skipServer = false }) {
  const known = new Set(SCENARIOS.map((scenario) => scenario.name));
  const requested = only === undefined || only === null ? null : only.split(",");
  for (const name of requested ?? []) {
    if (!known.has(name)) {
      throw new Error(
        `unknown scenario "${name}" in --only; expected ${[...known].join(", ")}`,
      );
    }
  }
  return new Set(
    SCENARIOS.filter(
      (scenario) =>
        (requested === null || requested.includes(scenario.name)) &&
        !(skipBrowser && scenario.browser) &&
        !(skipServer && !scenario.browser),
    ).map((scenario) => scenario.name),
  );
}

export function resolveThresholdsPath({ thresholds, baseline }, defaultPath) {
  if (thresholds !== undefined) return thresholds;
  return baseline === undefined ? undefined : defaultPath;
}

export function baselineSummaryOf(parsed, path) {
  const summary = parsed?.summary;
  if (
    parsed?.schema !== "bb-perf-v1" ||
    summary === null ||
    typeof summary !== "object"
  ) {
    throw new Error(`${path} is not a bb-perf-v1 result with a summary`);
  }
  return summary;
}

export function incompleteMetrics(summary, scenarios) {
  const incomplete = [];
  for (const [name, stats] of Object.entries(summary)) {
    if (stats.expected === undefined || stats.n >= stats.expected) continue;
    const scenario = scenarioOfMetric(name);
    if (scenarios !== undefined && scenario !== null && !scenarios.has(scenario)) {
      continue;
    }
    incomplete.push({
      name,
      expected: stats.expected,
      n: stats.n,
      reasons: stats.failureReasons ?? [],
    });
  }
  return incomplete;
}

export function emptyScenarios(summary, scenarios) {
  return SCENARIOS.filter(
    (scenario) =>
      scenarios.has(scenario.name) &&
      !Object.entries(summary).some(
        ([name, stats]) =>
          stats.n > 0 && scenarioOfMetric(name) === scenario.name,
      ),
  ).map((scenario) => scenario.name);
}

export function aggregateRuns(runs) {
  const names = new Set();
  for (const run of runs) {
    for (const name of Object.keys(run.samples)) names.add(name);
    for (const name of Object.keys(run.expected ?? {})) names.add(name);
  }
  const summary = {};
  for (const name of [...names].sort()) {
    const pooled = [];
    const runMedians = [];
    let expected;
    let failed = 0;
    const failureReasons = [];
    for (const run of runs) {
      if (run.expected?.[name] !== undefined) {
        expected = (expected ?? 0) + run.expected[name];
      }
      const failure = run.failures?.[name];
      if (failure !== undefined) {
        failed += failure.count;
        for (const reason of failure.reasons) {
          if (!failureReasons.includes(reason)) failureReasons.push(reason);
        }
      }
    }
    for (const run of runs) {
      const values = (run.samples[name] ?? []).filter((value) =>
        Number.isFinite(value),
      );
      if (values.length === 0) continue;
      pooled.push(...values);
      runMedians.push(summarize(values).p50);
    }
    const medianSummary = summarize(runMedians);
    summary[name] = {
      ...summarize(pooled),
      runs: runMedians.length,
      runMedians,
      runMedianCv: medianSummary.cv,
      runMedianMin: medianSummary.min,
      runMedianMax: medianSummary.max,
      ...(expected === undefined ? {} : { expected, failed, failureReasons }),
    };
  }
  return summary;
}

export function summarizeRouteTimings(timingsByRoute) {
  const result = {};
  for (const [route, samples] of Object.entries(timingsByRoute)) {
    result[route] = summarize(samples);
  }
  return result;
}

export function checkThresholds(
  summary,
  thresholds,
  baselineSummary,
  { scenarios } = {},
) {
  const failures = [];
  const checked = [];
  const skipped = [];
  for (const [name, rule] of Object.entries(thresholds.metrics)) {
    const scenario = scenarioOfMetric(name);
    if (scenarios !== undefined && scenario !== null && !scenarios.has(scenario)) {
      skipped.push(name);
      continue;
    }
    const current = summary[name];
    if (current === undefined || current.n === 0) {
      failures.push({ name, kind: "missing", message: "no samples recorded" });
      continue;
    }
    if (current.expected !== undefined && current.n < current.expected) {
      const reasons = (current.failureReasons ?? []).join("; ");
      failures.push({
        name,
        kind: "incomplete",
        message: `${current.n} of ${current.expected} expected samples${reasons === "" ? "" : ` (${reasons})`}`,
      });
    }
    const entry = { name, p50: current.p50, p95: current.p95 };
    checked.push(entry);
    if (rule.maxP50Ms !== undefined && current.p50 > rule.maxP50Ms) {
      failures.push({
        name,
        kind: "budget-p50",
        message: `p50 ${current.p50}ms exceeds budget ${rule.maxP50Ms}ms`,
      });
    }
    if (rule.maxP95Ms !== undefined && current.p95 > rule.maxP95Ms) {
      failures.push({
        name,
        kind: "budget-p95",
        message: `p95 ${current.p95}ms exceeds budget ${rule.maxP95Ms}ms`,
      });
    }
    const base = baselineSummary?.[name];
    if (base !== undefined && base.n > 0) {
      const pct = rule.regressionPct ?? thresholds.defaults.regressionPct;
      const floor = rule.regressionMinMs ?? thresholds.defaults.regressionMinMs;
      for (const stat of ["p50", "p95"]) {
        const delta = current[stat] - base[stat];
        if (delta > floor && delta > (base[stat] * pct) / 100) {
          failures.push({
            name,
            kind: `regression-${stat}`,
            message: `${stat} ${current[stat]}ms vs baseline ${base[stat]}ms (+${round(delta)}ms, +${round((delta / base[stat]) * 100)}%)`,
          });
        }
      }
    }
  }
  return { failures, checked, skipped };
}

function cell(value) {
  return value === null || value === undefined ? "-" : String(value);
}

export function renderTable(summary, { title, machine } = {}) {
  const rows = Object.entries(summary);
  const nameWidth = Math.max(6, ...rows.map(([name]) => name.length));
  const header = [
    "metric".padEnd(nameWidth),
    "n".padStart(4),
    "p50".padStart(8),
    "p95".padStart(8),
    "min".padStart(8),
    "max".padStart(8),
    "cv%".padStart(6),
    "runs".padStart(5),
    "run-p50 range".padStart(16),
  ].join("  ");
  const lines = [];
  if (title !== undefined) lines.push(title);
  if (machine !== undefined) lines.push(machine);
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const [name, stats] of rows) {
    lines.push(
      [
        name.padEnd(nameWidth),
        cell(stats.n).padStart(4),
        cell(stats.p50).padStart(8),
        cell(stats.p95).padStart(8),
        cell(stats.min).padStart(8),
        cell(stats.max).padStart(8),
        cell(stats.cv).padStart(6),
        cell(stats.runs).padStart(5),
        `${cell(stats.runMedianMin)}-${cell(stats.runMedianMax)}`.padStart(16),
      ].join("  "),
    );
  }
  return lines.join("\n");
}
