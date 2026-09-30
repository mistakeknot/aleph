import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  baselineSummaryOf,
  checkThresholds,
  emptyScenarios,
  incompleteMetrics,
  percentile,
  Recorder,
  renderTable,
  resolveThresholdsPath,
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

  it("lets the documented smoke selection pass the shipped thresholds", () => {
    const thresholds = JSON.parse(readFileSync(join(perfDir, "thresholds.json"), "utf8"));
    const scenarios = selectScenarios({ only: "server,cmdk,switch" });
    const summary = {};
    for (const name of Object.keys(thresholds.metrics)) {
      if (scenarios.has(scenarioOfMetric(name))) {
        summary[name] = { n: 5, expected: 5, p50: 1, p95: 1 };
      }
    }
    const scoped = checkThresholds(summary, thresholds, undefined, { scenarios });
    expect(scoped.failures).toEqual([]);
    expect(scoped.skipped).toEqual(
      expect.arrayContaining([
        "startup.shell_ms",
        "thread_open.large_ms",
        "composer.type_home_ms",
      ]),
    );
    expect(scoped.checked.length).toBeGreaterThan(0);
    const unscoped = checkThresholds(summary, thresholds);
    expect(unscoped.failures.every((failure) => failure.kind === "missing")).toBe(true);
    expect(unscoped.failures.length).toBeGreaterThan(0);
  });

  it("still fails a selected scenario's metric that has no samples", () => {
    const thresholds = {
      defaults: { regressionPct: 25, regressionMinMs: 30 },
      metrics: {
        "cmdk.open_ms": { maxP50Ms: 500 },
        "switch.click_ms": { maxP50Ms: 500 },
      },
    };
    const { failures } = checkThresholds(
      { "cmdk.open_ms": { n: 1, p50: 1, p95: 1 } },
      thresholds,
      undefined,
      { scenarios: new Set(["cmdk", "switch"]) },
    );
    expect(failures.map((failure) => failure.name)).toEqual(["switch.click_ms"]);
  });
});

describe("perf harness baseline flag", () => {
  it("uses the default thresholds when only --baseline is given", () => {
    expect(resolveThresholdsPath({ baseline: "b.json" }, "default.json")).toBe(
      "default.json",
    );
    expect(
      resolveThresholdsPath({ baseline: "b.json", thresholds: "t.json" }, "default.json"),
    ).toBe("t.json");
    expect(resolveThresholdsPath({}, "default.json")).toBeUndefined();
  });

  it("rejects a baseline file without a perf summary", () => {
    expect(baselineSummaryOf({ schema: "bb-perf-v1", summary: { a: 1 } }, "b.json")).toEqual({
      a: 1,
    });
    expect(() => baselineSummaryOf({ summary: {} }, "b.json")).toThrow(/bb-perf-v1/u);
    expect(() => baselineSummaryOf({ schema: "bb-perf-v1" }, "b.json")).toThrow(/summary/u);
  });

  it("flags a regression against the shipped baseline under default thresholds", () => {
    const thresholds = JSON.parse(readFileSync(join(perfDir, "thresholds.json"), "utf8"));
    const baseline = baselineSummaryOf(
      JSON.parse(
        readFileSync(join(perfDir, "baselines/2026-09-30-baseline.json"), "utf8"),
      ),
      "baseline",
    );
    const current = structuredClone(baseline);
    current["cmdk.open_warm_ms"].p50 += 60;
    const { failures } = checkThresholds(current, thresholds, baseline, {
      scenarios: new Set(["cmdk"]),
    });
    expect(failures.map((failure) => failure.kind)).toContain("regression-p50");
  });
});
