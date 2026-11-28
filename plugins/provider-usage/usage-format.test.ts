import { describe, expect, it } from "vitest";
import {
  describeUsageBurn,
  sortAccountsByExhaustion,
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
        {
          kind: "five-hour",
          observedAt: NOW,
          usedPercent: 30,
          resetsAt: resetIn(3 * HOUR),
        },
        NOW,
      ),
    ).toEqual({ percentPerHour: 15, runsOutInMs: null });
  });

  it("projects when a fast burn runs out before the reset", () => {
    expect(
      usageBurnRate(
        {
          kind: "weekly",
          observedAt: NOW,
          usedPercent: 50,
          resetsAt: resetIn(6 * 24 * HOUR),
        },
        NOW,
      ),
    ).toEqual({ percentPerHour: 50 / 24, runsOutInMs: 24 * HOUR });
  });

  it("withholds the rate for an exhausted window", () => {
    expect(
      usageBurnRate(
        {
          kind: "five-hour",
          observedAt: NOW,
          usedPercent: 104,
          resetsAt: resetIn(HOUR),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("withholds the rate when the provider refused usage below 100%", () => {
    expect(
      usageBurnRate(
        {
          kind: "five-hour",
          observedAt: NOW,
          usedPercent: 91,
          resetsAt: resetIn(HOUR),
          limitReached: true,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("anchors the average and run-out to the observation instead of the clock tick", () => {
    const reading = {
      kind: "five-hour" as const,
      usedPercent: 50,
      resetsAt: resetIn(4 * HOUR),
      observedAt: NOW,
    };
    expect(usageBurnRate(reading, NOW + HOUR / 2)).toEqual({
      percentPerHour: 50,
      runsOutInMs: HOUR / 2,
    });
  });

  it.each([
    ["stale observation", NOW - HOUR - 1, resetIn(2 * HOUR), 30],
    ["expired reset", NOW - HOUR / 2, resetIn(0), 30],
    [
      "observation from before the cycle",
      NOW - HOUR / 2,
      resetIn(4.75 * HOUR),
      30,
    ],
    ["missing timestamp", undefined, resetIn(2 * HOUR), 30],
    ["one point of usage", NOW, resetIn(2 * HOUR), 1],
  ] as const)(
    "withholds an estimate for %s",
    (_reason, observedAt, resetsAt, usedPercent) => {
      expect(
        usageBurnRate(
          { kind: "five-hour", observedAt, resetsAt, usedPercent },
          NOW,
        ),
      ).toBeNull();
    },
  );

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
          observedAt: NOW,
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
      "Cycle average 15%/hr from one reading · projected to last until reset",
    );
    expect(
      describeUsageBurn({
        percentPerHour: 50 / 24,
        runsOutInMs: 25 * HOUR + 10 * 60_000,
      }),
    ).toBe(
      "Cycle average 2.1%/hr from one reading · projected to run out in 1d 1h",
    );
    expect(describeUsageBurn({ percentPerHour: 0, runsOutInMs: null })).toBe(
      "No usage reported in the last reading",
    );
    expect(describeUsageBurn({ percentPerHour: 0.04, runsOutInMs: null })).toBe(
      "Cycle average <0.1%/hr from one reading · projected to last until reset",
    );
    expect(describeUsageBurn({ percentPerHour: 26, runsOutInMs: 0 })).toBe(
      "Cycle average 26%/hr from one reading · projected limit time has passed",
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

describe("sortAccountsByExhaustion", () => {
  function account(
    name: string,
    usedPercent: number,
    resetsAt: string | null,
    kind: "five-hour" | "weekly" = "weekly",
  ) {
    return {
      name,
      usage: {
        status: "ok",
        windows: [{ kind, usedPercent, resetsAt, observedAt: NOW }],
      },
    };
  }
  const names = (accounts: { name: string }[]) => accounts.map((a) => a.name);

  it("puts an already exhausted account before one projected to run out soon", () => {
    const exhausted = account("exhausted", 100, resetIn(2 * HOUR), "five-hour");
    const soon = account("six-hours", 80, resetIn(6 * 24 * HOUR));
    expect(names(sortAccountsByExhaustion([soon, exhausted], NOW))).toEqual([
      "exhausted",
      "six-hours",
    ]);
  });

  it("puts an exhausted account before accounts with no projection", () => {
    const exhausted = account("exhausted", 100, resetIn(2 * HOUR), "five-hour");
    const none = account("none", 5, null);
    expect(names(sortAccountsByExhaustion([none, exhausted], NOW))).toEqual([
      "exhausted",
      "none",
    ]);
  });
});
