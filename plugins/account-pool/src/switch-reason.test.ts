import { describe, expect, it } from "vitest";
import {
  EMPTY_FAMILY_WEEKLY,
  type Account,
  type AccountQuota,
  type LimitWindow,
  type LimitWindowSlot,
} from "./contracts.js";
import { switchReason, usagePercent } from "./quota.js";

const NOW = 1_800_000_000_000;
const account = { id: "a", enabled: true } as Account;
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
    accountId: "11111111-1111-4111-8111-111111111111",
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

describe("switchReason", () => {
  it("classifies why the previous active account was left", () => {
    const reason = (acct: Account | undefined, q: AccountQuota) =>
      switchReason(acct, q, "other", 0.98, NOW);
    expect(reason(undefined, quota())).toBe("account_unavailable");
    expect(reason({ ...account, enabled: false }, quota())).toBe(
      "account_unavailable",
    );
    expect(reason(account, quota({ error: "login expired" }))).toBe(
      "account_unavailable",
    );
    expect(
      reason(
        account,
        quota({ fiveHourStatus: "rejected", fiveHourResetAt: NOW + 1000 }),
      ),
    ).toBe("limit_reached");
    expect(
      reason(
        account,
        quota({ sevenDayUtilization: 0.99, sevenDayResetAt: NOW + 1000 }),
      ),
    ).toBe("threshold_crossed");
    expect(reason(account, quota({ sevenDayUtilization: 0.2 }))).toBe("other");
  });

  it("reports the highest live window utilization as a percent", () => {
    expect(usagePercent(quota(), "other", NOW)).toBeNull();
    expect(
      usagePercent(
        quota({
          fiveHourUtilization: 0.5,
          sevenDayUtilization: 0.731,
          sevenDayResetAt: NOW + 1,
        }),
        "other",
        NOW,
      ),
    ).toBe(73.1);
  });
});
