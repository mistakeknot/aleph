import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  checkThresholds,
  percentile,
  renderTable,
  summarize,
} from "../../../scripts/perf/lib.mjs";

describe("perf harness statistics", () => {
  it("interpolates percentiles over sorted samples", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("ignores non-finite samples and reports dispersion", () => {
    const stats = summarize([100, 110, Number.NaN, 90, null, 100]);
    expect(stats.n).toBe(4);
    expect(stats.p50).toBe(100);
    expect(stats.min).toBe(90);
    expect(stats.max).toBe(110);
    expect(stats.cv).toBeGreaterThan(0);
    expect(summarize([]).p50).toBeNull();
  });

  it("pools samples across runs and reports the spread of run medians", () => {
    const summary = aggregateRuns([
      { samples: { "cmdk.open_ms": [100, 120], "only.first": [1] } },
      { samples: { "cmdk.open_ms": [200, 220] } },
      { samples: { "cmdk.open_ms": [] } },
    ]);
    expect(summary["cmdk.open_ms"].n).toBe(4);
    expect(summary["cmdk.open_ms"].runs).toBe(2);
    expect(summary["cmdk.open_ms"].runMedians).toEqual([110, 210]);
    expect(summary["cmdk.open_ms"].runMedianMin).toBe(110);
    expect(summary["cmdk.open_ms"].runMedianMax).toBe(210);
    expect(summary["only.first"].runs).toBe(1);
  });
});

describe("perf harness thresholds", () => {
  const thresholds = {
    defaults: { regressionPct: 25, regressionMinMs: 30 },
    metrics: {
      "switch.click_ms": { maxP50Ms: 500, maxP95Ms: 900 },
      "cmdk.open_ms": { regressionPct: 10, regressionMinMs: 5 },
    },
  };
  const stats = (p50, p95) => ({ n: 5, p50, p95 });

  it("passes when metrics are inside budgets and near the baseline", () => {
    const { failures, checked } = checkThresholds(
      { "switch.click_ms": stats(400, 800), "cmdk.open_ms": stats(100, 120) },
      thresholds,
      { "switch.click_ms": stats(390, 780), "cmdk.open_ms": stats(98, 118) },
    );
    expect(failures).toEqual([]);
    expect(checked).toHaveLength(2);
  });

  it("fails absolute budgets and reports each exceeded percentile", () => {
    const { failures } = checkThresholds(
      { "switch.click_ms": stats(600, 1000), "cmdk.open_ms": stats(100, 120) },
      thresholds,
    );
    expect(failures.map((failure) => failure.kind)).toEqual([
      "budget-p50",
      "budget-p95",
    ]);
  });

  it("requires both the relative and the absolute regression margin", () => {
    const baseline = { "cmdk.open_ms": stats(100, 120) };
    const smallAbsolute = checkThresholds(
      { "switch.click_ms": stats(1, 1), "cmdk.open_ms": stats(103, 123) },
      thresholds,
      baseline,
    );
    expect(smallAbsolute.failures.map((failure) => failure.kind)).toEqual([]);
    const regression = checkThresholds(
      { "switch.click_ms": stats(1, 1), "cmdk.open_ms": stats(140, 121) },
      thresholds,
      baseline,
    );
    expect(regression.failures.map((failure) => failure.kind)).toEqual([
      "regression-p50",
    ]);
  });

  it("fails a metric that recorded no samples", () => {
    const { failures } = checkThresholds({}, thresholds);
    expect(failures.map((failure) => failure.kind)).toEqual([
      "missing",
      "missing",
    ]);
  });

  it("renders one row per metric with the machine line", () => {
    const table = renderTable(
      aggregateRuns([{ samples: { "a.b_ms": [10, 20, 30] } }]),
      { title: "title", machine: "box" },
    );
    expect(table.split("\n")[0]).toBe("title");
    expect(table).toContain("a.b_ms");
    expect(table).toContain("box");
  });
});
