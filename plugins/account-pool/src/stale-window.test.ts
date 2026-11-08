import { describe, expect, it } from "vitest";
import { formatAccounts } from "./cli.js";
import {
  EMPTY_FAMILY_WEEKLY,
  type AccountQuota,
  type AccountSummary,
  type FamilyQuota,
  type LimitWindow,
  type LimitWindowSlot,
} from "./contracts.js";
import { isPastThreshold, quotaFromHeaders, usagePercent } from "./quota.js";
import { quotaFromUsage } from "./usage.js";

const NOW = 1_800_000_000_000;
const PAST = NOW - 86_400_000;
const FUTURE = NOW + 3_600_000;
const ID = "11111111-1111-4111-8111-111111111111";

interface WindowShorthand {
  fiveHourUtilization?: number | null;
  fiveHourResetAt?: number | null;
  fiveHourStatus?: string | null;
  sevenDayUtilization?: number | null;
  sevenDayResetAt?: number | null;
  sevenDayStatus?: string | null;
}

const shorthandWindow = (
  slot: LimitWindowSlot,
  utilization: number | null | undefined,
  resetAt: number | null | undefined,
  status: string | null | undefined,
): LimitWindow[] =>
  utilization === undefined && resetAt === undefined && status === undefined
    ? []
    : [
        {
          slot,
          windowMinutes: slot === "primary" ? 300 : 10_080,
          utilization: utilization ?? null,
          resetAt: resetAt ?? null,
          status: status ?? null,
          observedAt: NOW - 1000,
          source: "header",
        },
      ];

const slotOf = (
  value: { limitWindows: readonly LimitWindow[] } | null | undefined,
  slot: LimitWindowSlot,
): {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
} =>
  value?.limitWindows.find((window) => window.slot === slot) ?? {
    utilization: null,
    resetAt: null,
    status: null,
  };

const quota = (
  input: Partial<AccountQuota> & WindowShorthand = {},
): AccountQuota => {
  const {
    fiveHourUtilization,
    fiveHourResetAt,
    fiveHourStatus,
    sevenDayUtilization,
    sevenDayResetAt,
    sevenDayStatus,
    ...patch
  } = input;
  return {
    accountId: ID,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [
      ...shorthandWindow(
        "primary",
        fiveHourUtilization,
        fiveHourResetAt,
        fiveHourStatus,
      ),
      ...shorthandWindow(
        "secondary",
        sevenDayUtilization,
        sevenDayResetAt,
        sevenDayStatus,
      ),
    ],
    extraUsage: null,
    usageRestriction: null,
    observedAt: null,
    heldUntil: null,
    error: null,
    ...patch,
  };
};

const family = (patch: Partial<FamilyQuota> = {}): FamilyQuota => ({
  utilization: 0.4,
  resetAt: FUTURE,
  status: "allowed",
  observedAt: NOW - 1000,
  source: "usage",
  ...patch,
});

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("quotaFromHeaders with a past-reset window", () => {
  const stale = quota({
    fiveHourUtilization: 0,
    fiveHourResetAt: PAST,
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.3,
    sevenDayResetAt: FUTURE,
    sevenDayStatus: "allowed",
  });

  it("stores an unreported window whose reset has passed as unknown", () => {
    const next = quotaFromHeaders(
      ID,
      headers({
        "anthropic-ratelimit-unified-7d-utilization": "0.35",
        "anthropic-ratelimit-unified-7d-reset": String(FUTURE / 1000),
      }),
      stale,
      "other",
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBeNull();
    expect(slotOf(next, "primary").status).toBeNull();
  });

  it("keeps the previous value of a window whose reset is still ahead", () => {
    const next = quotaFromHeaders(
      ID,
      headers({
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
      }),
      stale,
      "other",
      NOW,
    );
    expect(slotOf(next, "secondary").utilization).toBe(0.3);
    expect(slotOf(next, "secondary").resetAt).toBe(FUTURE);
    expect(slotOf(next, "secondary").status).toBe("allowed");
  });

  it("lets fresh values override a stale window", () => {
    const next = quotaFromHeaders(
      ID,
      headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.2",
        "anthropic-ratelimit-unified-5h-reset": String(FUTURE / 1000),
        "anthropic-ratelimit-unified-5h-status": "allowed",
      }),
      stale,
      "other",
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBe(0.2);
    expect(slotOf(next, "primary").resetAt).toBe(FUTURE);
    expect(slotOf(next, "primary").status).toBe("allowed");
  });

  it("does not carry a stale status into a freshly reported window", () => {
    const next = quotaFromHeaders(
      ID,
      headers({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }),
      quota({
        fiveHourUtilization: 1,
        fiveHourResetAt: PAST,
        fiveHourStatus: "rejected",
      }),
      "other",
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBe(0.2);
    expect(slotOf(next, "primary").status).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBeNull();
  });

  it("keeps a window with no reset time", () => {
    const next = quotaFromHeaders(
      ID,
      headers({}),
      quota({ fiveHourUtilization: 0.5 }),
      "other",
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBe(0.5);
  });

  it("expires a past family window and keeps a future one", () => {
    const next = quotaFromHeaders(
      ID,
      headers({}),
      quota({
        familyWeekly: {
          ...EMPTY_FAMILY_WEEKLY,
          opus: family({ resetAt: PAST, utilization: 0 }),
          sonnet: family({ resetAt: FUTURE, utilization: 0.6 }),
        },
      }),
      "other",
      NOW,
    );
    expect(next.familyWeekly.opus).toBeNull();
    expect(next.familyWeekly.sonnet?.utilization).toBe(0.6);
  });

  it("merges a fresh scoped family header over an expired prior entry", () => {
    const next = quotaFromHeaders(
      ID,
      headers({
        "anthropic-ratelimit-unified-7d_opus-utilization": "0.1",
      }),
      quota({
        familyWeekly: {
          ...EMPTY_FAMILY_WEEKLY,
          opus: family({ resetAt: PAST, status: "rejected" }),
        },
      }),
      "opus",
      NOW,
    );
    expect(next.familyWeekly.opus?.utilization).toBe(0.1);
    expect(next.familyWeekly.opus?.resetAt).toBeNull();
    expect(next.familyWeekly.opus?.status).toBeNull();
  });

  it("leaves routing unaffected by the unknown window", () => {
    const next = quotaFromHeaders(ID, headers({}), stale, "other", NOW);
    expect(isPastThreshold(next, "other", 0.9, NOW)).toBe(false);
    expect(usagePercent(next, "other", NOW)).toBe(30);
  });

  it("stores every window as unknown when all resets have passed and stays eligible", () => {
    const allPast = quota({
      fiveHourUtilization: 0.95,
      fiveHourResetAt: PAST,
      fiveHourStatus: "rejected",
      sevenDayUtilization: 0.97,
      sevenDayResetAt: PAST,
      sevenDayStatus: "rejected",
    });
    const next = quotaFromHeaders(ID, headers({}), allPast, "other", NOW);
    expect(slotOf(next, "primary").utilization).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBeNull();
    expect(slotOf(next, "primary").status).toBeNull();
    expect(slotOf(next, "secondary").utilization).toBeNull();
    expect(slotOf(next, "secondary").resetAt).toBeNull();
    expect(slotOf(next, "secondary").status).toBeNull();
    expect(usagePercent(next, "other", NOW)).toBeNull();
    expect(isPastThreshold(next, "other", 0.9, NOW)).toBe(false);
  });

  it("treats a reset equal to now as past", () => {
    const atNow = quota({
      fiveHourUtilization: 0.5,
      fiveHourResetAt: NOW,
      fiveHourStatus: "allowed",
    });
    const next = quotaFromHeaders(ID, headers({}), atNow, "other", NOW);
    expect(slotOf(next, "primary").utilization).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBeNull();
    expect(slotOf(next, "primary").status).toBeNull();
  });

  it("keeps utilization unknown when only a reset and status arrive for a past window", () => {
    const next = quotaFromHeaders(
      ID,
      headers({
        "anthropic-ratelimit-unified-5h-reset": String(
          Math.floor(FUTURE / 1000),
        ),
        "anthropic-ratelimit-unified-5h-status": "allowed",
      }),
      stale,
      "other",
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBe(Math.floor(FUTURE / 1000) * 1000);
    expect(slotOf(next, "primary").status).toBe("allowed");
  });
});

describe("quotaFromUsage with a past-reset window", () => {
  const stale = quota({
    fiveHourUtilization: 0,
    fiveHourResetAt: PAST,
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.3,
    sevenDayResetAt: FUTURE,
    sevenDayStatus: "allowed",
  });
  const sevenDayOnly = {
    seven_day: { utilization: 35, resets_at: FUTURE },
  };

  it("stores an omitted window whose reset has passed as unknown", () => {
    const next = quotaFromUsage(ID, sevenDayOnly, stale, NOW);
    expect(slotOf(next, "primary").utilization).toBeNull();
    expect(slotOf(next, "primary").resetAt).toBeNull();
    expect(slotOf(next, "primary").status).toBeNull();
    expect(slotOf(next, "secondary").utilization).toBeCloseTo(0.35);
  });

  it("stores a null five_hour bucket whose reset has passed as unknown", () => {
    const next = quotaFromUsage(
      ID,
      { five_hour: null, ...sevenDayOnly },
      stale,
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBeNull();
  });

  it("keeps the previous value of an omitted window whose reset is ahead", () => {
    const next = quotaFromUsage(
      ID,
      { five_hour: { utilization: 20, resets_at: FUTURE } },
      stale,
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBeCloseTo(0.2);
    expect(slotOf(next, "secondary").utilization).toBe(0.3);
    expect(slotOf(next, "secondary").resetAt).toBe(FUTURE);
    expect(slotOf(next, "secondary").status).toBe("allowed");
  });

  it("lets a fresh value override a stale window", () => {
    const next = quotaFromUsage(
      ID,
      {
        five_hour: { utilization: 55, resets_at: FUTURE },
        ...sevenDayOnly,
      },
      stale,
      NOW,
    );
    expect(slotOf(next, "primary").utilization).toBeCloseTo(0.55);
    expect(slotOf(next, "primary").resetAt).toBe(FUTURE);
    expect(slotOf(next, "primary").status).toBe("allowed");
  });

  it("expires a past family window carried from the previous quota", () => {
    const next = quotaFromUsage(
      ID,
      sevenDayOnly,
      quota({
        familyWeekly: {
          ...EMPTY_FAMILY_WEEKLY,
          opus: family({ resetAt: PAST, utilization: 0 }),
          sonnet: family({ resetAt: FUTURE, utilization: 0.6 }),
        },
      }),
      NOW,
    );
    expect(next?.familyWeekly.opus).toBeNull();
    expect(next?.familyWeekly.sonnet?.utilization).toBe(0.6);
  });

  it("lets a fresh family bucket override a past one", () => {
    const next = quotaFromUsage(
      ID,
      { seven_day_opus: { utilization: 12, resets_at: FUTURE } },
      quota({
        familyWeekly: {
          ...EMPTY_FAMILY_WEEKLY,
          opus: family({ resetAt: PAST, utilization: 0 }),
        },
      }),
      NOW,
    );
    expect(next?.familyWeekly.opus?.utilization).toBeCloseTo(0.12);
    expect(next?.familyWeekly.opus?.resetAt).toBe(FUTURE);
  });
});

describe("account list display of an unknown window", () => {
  it("omits an unknown window from the windows column", () => {
    const summary = {
      id: ID,
      label: "claude-a",
      email: null,
      provider: "claude",
      kind: "oauth",
      enabled: true,
      priority: 1,
      status: "ready",
      ...quota({ sevenDayUtilization: 0.35, sevenDayResetAt: FUTURE }),
    } as unknown as AccountSummary;
    const row = formatAccounts([summary]).split("\n")[1]?.split("\t") ?? [];
    expect(row[7]).toBe(`7d=35% ${new Date(FUTURE).toISOString()}`);
  });
});
