import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  checkThresholds,
  emptyScenarios,
  incompleteMetrics,
  percentile,
  Recorder,
  renderTable,
  scenarioOfMetric,
  selectScenarios,
  summarize,
} from "../../../scripts/perf/lib.mjs";

const perfDir = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/perf");

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

describe("perf harness sample accounting", () => {
  it("records non-finite results as failures instead of dropping them", () => {
    const recorder = new Recorder();
    recorder.add("switch.click_ms", 100);
    recorder.add("switch.click_ms", null, "timed out");
    recorder.add("switch.click_ms", Number.NaN);
    recorder.missing("composer.type_ms", 2, "never reflected");
    recorder.missing("composer.type_ms", 0, "ignored");
    expect(recorder.samples).toEqual({ "switch.click_ms": [100] });
    expect(recorder.expected).toEqual({ "switch.click_ms": 3, "composer.type_ms": 2 });
    expect(recorder.failures["switch.click_ms"]).toEqual({
      count: 2,
      reasons: ["timed out", "no value"],
    });
  });

  it("pools expected counts and keeps all-failed metrics in the summary", () => {
    const first = new Recorder();
    first.add("switch.click_ms", 100);
    first.add("switch.click_ms", null, "timed out");
    first.add("switch.enter_ms", null, "timed out");
    const second = new Recorder();
    second.add("switch.click_ms", 120);
    second.add("switch.click_ms", 140);
    second.add("switch.enter_ms", null, "no value");
    const summary = aggregateRuns(
      [first, second].map((recorder) => ({
        samples: recorder.samples,
        expected: recorder.expected,
        failures: recorder.failures,
      })),
    );
    expect(summary["switch.click_ms"]).toMatchObject({
      n: 3,
      expected: 4,
      failed: 1,
      failureReasons: ["timed out"],
    });
    expect(summary["switch.enter_ms"]).toMatchObject({
      n: 0,
      expected: 2,
      failed: 2,
      failureReasons: ["timed out", "no value"],
    });
    expect(incompleteMetrics(summary).map((metric) => metric.name)).toEqual([
      "switch.click_ms",
      "switch.enter_ms",
    ]);
  });

  it("does not flag results recorded without expected counts", () => {
    const summary = aggregateRuns([{ samples: { "a.b_ms": [1] } }]);
    expect(incompleteMetrics(summary)).toEqual([]);
    expect(summary["a.b_ms"].expected).toBeUndefined();
  });

  it("fails thresholds for a metric with fewer samples than expected", () => {
    const thresholds = {
      defaults: { regressionPct: 25, regressionMinMs: 30 },
      metrics: { "switch.click_ms": { maxP50Ms: 500 } },
    };
    const { failures } = checkThresholds(
      {
        "switch.click_ms": {
          n: 4,
          expected: 5,
          p50: 100,
          p95: 100,
          failureReasons: ["timed out"],
        },
      },
      thresholds,
    );
    expect(failures).toEqual([
      {
        name: "switch.click_ms",
        kind: "incomplete",
        message: "4 of 5 expected samples (timed out)",
      },
    ]);
  });

  it("reports selected scenarios that produced no samples", () => {
    const summary = aggregateRuns([
      { samples: { "cmdk.open_ms": [1] }, expected: { "switch.click_ms": 1 } },
    ]);
    expect(emptyScenarios(summary, new Set(["cmdk", "switch"]))).toEqual(["switch"]);
  });
});

describe("perf harness scenario scoping", () => {
  it("maps metric names to scenarios", () => {
    expect(scenarioOfMetric("startup_warm.shell_ms")).toBe("startup");
    expect(scenarioOfMetric("thread_open.small_ms")).toBe("thread");
    expect(scenarioOfMetric("server.search-1_ms")).toBe("server");
    expect(scenarioOfMetric("other.metric")).toBeNull();
  });

  it("selects scenarios from --only and the skip flags and rejects unknown names", () => {
    expect([...selectScenarios({ only: "server,cmdk" })]).toEqual(["cmdk", "server"]);
    expect([...selectScenarios({ skipBrowser: true })]).toEqual(["server"]);
    expect(selectScenarios({ skipServer: true }).has("server")).toBe(false);
    expect(selectScenarios({}).size).toBe(6);
    expect(() => selectScenarios({ only: "cmdk,nope" })).toThrow(/unknown scenario "nope"/u);
  });
});
