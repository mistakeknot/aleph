import { describe, expect, it } from "vitest";
import {
  describeUsageBurn,
  formatUsageBurnRate,
  usageBurnRate,
  usageProjectedPercent,
} from "./usage-format.js";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 27, 12);

function resetIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe("usageBurnRate", () => {
  it("averages usage over the elapsed part of a known window", () => {
    expect(
      usageBurnRate(
        { kind: "five-hour", usedPercent: 30, resetsAt: resetIn(3 * HOUR) },
        NOW,
      ),
    ).toEqual({ percentPerHour: 15, runsOutInMs: null });
  });

  it("projects when a fast burn runs out before the reset", () => {
    expect(
      usageBurnRate(
        { kind: "weekly", usedPercent: 50, resetsAt: resetIn(6 * 24 * HOUR) },
        NOW,
      ),
    ).toEqual({ percentPerHour: 50 / 24, runsOutInMs: 24 * HOUR });
  });

  it("reports an exhausted window as already out", () => {
    expect(
      usageBurnRate(
        { kind: "five-hour", usedPercent: 104, resetsAt: resetIn(HOUR) },
        NOW,
      ),
    ).toEqual({ percentPerHour: 26, runsOutInMs: 0 });
  });

  it("needs a known window length, a reset time and some elapsed time", () => {
    expect(
      usageBurnRate(
        { kind: "custom", usedPercent: 30, resetsAt: resetIn(HOUR) },
        NOW,
      ),
    ).toBeNull();
    expect(
      usageBurnRate({ usedPercent: 30, resetsAt: resetIn(HOUR) }, NOW),
    ).toBeNull();
    expect(
      usageBurnRate({ kind: "daily", usedPercent: 30, resetsAt: null }, NOW),
    ).toBeNull();
    expect(
      usageBurnRate(
        {
          kind: "five-hour",
          usedPercent: 3,
          resetsAt: resetIn(5 * HOUR - 5 * 60_000),
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      usageBurnRate(
        { kind: "five-hour", usedPercent: 3, resetsAt: resetIn(6 * HOUR) },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("describeUsageBurn", () => {
  it("says how fast the window burns and whether it lasts to the reset", () => {
    expect(describeUsageBurn({ percentPerHour: 15, runsOutInMs: null })).toBe(
      "Burning 15%/hr · lasts until reset",
    );
    expect(
      describeUsageBurn({
        percentPerHour: 50 / 24,
        runsOutInMs: 25 * HOUR + 10 * 60_000,
      }),
    ).toBe("Burning 2.1%/hr · runs out in 1d 1h");
    expect(describeUsageBurn({ percentPerHour: 0, runsOutInMs: null })).toBe(
      "No usage yet this window",
    );
    expect(describeUsageBurn({ percentPerHour: 0.04, runsOutInMs: null })).toBe(
      "Burning <0.1%/hr · lasts until reset",
    );
    expect(describeUsageBurn({ percentPerHour: 26, runsOutInMs: 0 })).toBe(
      "Burning 26%/hr · limit reached",
    );
  });
});

describe("formatUsageBurnRate", () => {
  it("keeps one decimal below ten and rounds above", () => {
    expect(formatUsageBurnRate(0)).toBe("0");
    expect(formatUsageBurnRate(0.04)).toBe("<0.1");
    expect(formatUsageBurnRate(2.14)).toBe("2.1");
    expect(formatUsageBurnRate(3)).toBe("3");
    expect(formatUsageBurnRate(12.6)).toBe("13");
  });
});

describe("usageProjectedPercent", () => {
  it("extends the current burn to the reset, capped at the limit", () => {
    expect(
      usageProjectedPercent(
        { usedPercent: 40, resetsAt: resetIn(2 * HOUR) },
        { percentPerHour: 10, runsOutInMs: null },
        NOW,
      ),
    ).toBe(60);
    expect(
      usageProjectedPercent(
        { usedPercent: 80, resetsAt: resetIn(4 * HOUR) },
        { percentPerHour: 20, runsOutInMs: HOUR },
        NOW,
      ),
    ).toBe(100);
  });

  it("has no projection without a future reset", () => {
    const burn = { percentPerHour: 5, runsOutInMs: null };
    expect(
      usageProjectedPercent({ usedPercent: 10, resetsAt: null }, burn, NOW),
    ).toBeNull();
    expect(
      usageProjectedPercent(
        { usedPercent: 10, resetsAt: resetIn(-HOUR) },
        burn,
        NOW,
      ),
    ).toBeNull();
  });
});
