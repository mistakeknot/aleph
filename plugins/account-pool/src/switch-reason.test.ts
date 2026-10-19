import { describe, expect, it } from "vitest";
import {
  EMPTY_FAMILY_WEEKLY,
  type Account,
  type AccountQuota,
} from "./contracts.js";
import { switchReason, usagePercent } from "./quota.js";

const NOW = 1_800_000_000_000;
const account = { id: "a", enabled: true } as Account;
const quota = (patch: Partial<AccountQuota> = {}): AccountQuota => ({
  accountId: "11111111-1111-4111-8111-111111111111",
  fiveHourUtilization: null,
  fiveHourResetAt: null,
  fiveHourStatus: null,
  sevenDayUtilization: null,
  sevenDayResetAt: null,
  sevenDayStatus: null,
  representativeClaim: null,
  familyWeekly: EMPTY_FAMILY_WEEKLY,
  limitWindows: [],
  extraUsage: null,
  usageRestriction: null,
  observedAt: null,
  heldUntil: null,
  error: null,
  ...patch,
});

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
