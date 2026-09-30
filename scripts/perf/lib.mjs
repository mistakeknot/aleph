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

export function aggregateRuns(runs) {
  const names = new Set();
  for (const run of runs) {
    for (const name of Object.keys(run.samples)) names.add(name);
  }
  const summary = {};
  for (const name of [...names].sort()) {
    const pooled = [];
    const runMedians = [];
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

export function checkThresholds(summary, thresholds, baselineSummary) {
  const failures = [];
  const checked = [];
  for (const [name, rule] of Object.entries(thresholds.metrics)) {
    const current = summary[name];
    if (current === undefined || current.n === 0) {
      failures.push({ name, kind: "missing", message: "no samples recorded" });
      continue;
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
  return { failures, checked };
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
