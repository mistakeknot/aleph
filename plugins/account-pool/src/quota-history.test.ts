import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountQuota } from "./contracts.js";
import {
  codexWindowKeys,
  pooledConsumption,
  QuotaSampler,
  SAMPLE_HEARTBEAT_MS,
  SAMPLE_MIN_GAP_MS,
  SAMPLE_RETENTION_MS,
  type PooledAccount,
  type QuotaSample,
} from "./quota-history.js";
import { QUOTA_MIGRATIONS, QuotaSampleStore, QuotaStore } from "./store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FAR = NOW + 7 * 24 * HOUR;

function sample(
  accountId: string,
  minutesAgo: number,
  utilization: number,
  resetAt: number | null = FAR,
  windowKey: QuotaSample["windowKey"] = "seven-day",
): QuotaSample {
  return {
    accountId,
    windowKey,
    sampledAt: NOW - minutesAgo * MINUTE,
    utilization,
    resetAt,
  };
}

function pooled(
  id: string,
  windowKey: PooledAccount["windowKey"] = "seven-day",
) {
  return { id, label: `acct-${id.slice(0, 1)}`, windowKey };
}

describe("pooledConsumption", () => {
  it("sums increases from the baseline at the window start", () => {
    const result = pooledConsumption(
      [sample(A, 90, 0.1), sample(A, 30, 0.12), sample(A, 0, 0.14)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(3, 6);
    expect(result.accounts).toEqual([
      { id: A, label: "acct-1", pct: expect.closeTo(3, 6) },
    ]);
  });

  it("returns null until some account has two samples", () => {
    expect(pooledConsumption([], [pooled(A)], NOW).pct).toBeNull();
    expect(
      pooledConsumption([sample(A, 5, 0.3)], [pooled(A)], NOW).pct,
    ).toBeNull();
  });

  it("does not count a new account's first sample as consumption", () => {
    const result = pooledConsumption(
      [sample(A, 20, 0.4), sample(A, 10, 0.41)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(1, 6);
  });

  it("counts the first sample after a window roll in full from zero", () => {
    const resetAt = NOW - 30 * MINUTE;
    const result = pooledConsumption(
      [
        sample(A, 50, 0.9, resetAt),
        sample(A, 40, 0.95, resetAt),
        sample(A, 20, 0.02, FAR),
        sample(A, 0, 0.03, FAR),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(8, 6);
  });

  it("does not double count header-versus-poll jitter", () => {
    const result = pooledConsumption(
      [
        sample(A, 50, 0.5),
        sample(A, 40, 0.49),
        sample(A, 30, 0.5),
        sample(A, 20, 0.49),
        sample(A, 10, 0.51),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(1, 6);
  });

  it("never subtracts when utilization drops without a detected roll", () => {
    const result = pooledConsumption(
      [sample(A, 50, 0.9), sample(A, 10, 0.1)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("counts nothing for a stale window with no new samples", () => {
    const result = pooledConsumption(
      [
        sample(A, 200, 0.5, NOW - 100 * MINUTE),
        sample(A, 190, 0.52, NOW - 100 * MINUTE),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("prorates a gap longer than the hour by its overlap", () => {
    const result = pooledConsumption(
      [sample(A, 180, 0.1), sample(A, 0, 0.16)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
  });

  it("counts an expired reset once while unchanged readings repeat", () => {
    const expired = NOW - 100 * MINUTE;
    const result = pooledConsumption(
      [
        sample(A, 90, 0.5, expired),
        sample(A, 60, 0.5, expired),
        sample(A, 30, 0.5, expired),
        sample(A, 0, 0.5, expired),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(0, 6);
  });

  it("counts a retained expired reset once across a roll", () => {
    const reset = NOW - 30 * MINUTE;
    const result = pooledConsumption(
      [
        sample(A, 50, 0.9, reset),
        sample(A, 20, 0.02, reset),
        sample(A, 10, 0.03, reset),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(3, 6);
  });

  it("starts proration at the reset after a roll from an old baseline", () => {
    const result = pooledConsumption(
      [
        sample(A, 90, 0.8, NOW - 30 * MINUTE),
        sample(A, 0, 0.02, NOW + 7 * 24 * HOUR),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
  });

  it("ignores hour-boundary jitter around the epoch high-water mark", () => {
    const result = pooledConsumption(
      [sample(A, 70, 0.5), sample(A, 65, 0.49), sample(A, 55, 0.5)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("keeps the epoch high-water mark from before the window baseline", () => {
    const result = pooledConsumption(
      [sample(A, 65, 0.5), sample(A, 61, 0.49), sample(A, 50, 0.5)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("prorates a rolled epoch from the reset rather than the previous sample", () => {
    const result = pooledConsumption(
      [
        sample(A, 180, 0.9, NOW - 30 * MINUTE),
        sample(A, 0, 0.03, NOW + 7 * 24 * HOUR),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(3, 6);
  });

  it("averages over enabled accounts with a reading, exhausted ones included", () => {
    const result = pooledConsumption(
      [
        sample(A, 30, 0.2),
        sample(A, 0, 0.24),
        sample(B, 30, 1),
        sample(B, 0, 1),
      ],
      [pooled(A), pooled(B)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
    expect(result.accounts.map((entry) => entry.pct)).toEqual([
      expect.closeTo(4, 6),
      0,
    ]);
  });

  it("excludes accounts with no samples or no resolved window from the denominator", () => {
    const result = pooledConsumption(
      [sample(A, 30, 0.2), sample(A, 0, 0.24)],
      [
        pooled(A),
        { id: B, label: "no data", windowKey: null },
        pooled("33333333-3333-4333-8333-333333333333"),
      ],
      NOW,
    );
    expect(result.pct).toBeCloseTo(4, 6);
    expect(result.accounts).toHaveLength(1);
  });

  it("ignores samples of accounts that are not in the pool and other keys", () => {
    const result = pooledConsumption(
      [
        sample(A, 30, 0.2),
        sample(A, 0, 0.24),
        sample(B, 30, 0.2),
        sample(B, 0, 0.9),
        sample(A, 30, 0.1, FAR, "five-hour"),
        sample(A, 0, 0.9, FAR, "five-hour"),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(4, 6);
  });

  it("reads a joining account as zero until it has a second sample", () => {
    const result = pooledConsumption(
      [sample(A, 30, 0.2), sample(A, 0, 0.24), sample(B, 5, 0.7)],
      [pooled(A), pooled(B)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
  });

  it("ignores a baseline reset that had already passed", () => {
    const result = pooledConsumption(
      [
        sample(A, 20, 0.5, NOW - 30 * MINUTE),
        sample(A, 10, 0.5, NOW - 30 * MINUTE),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("does not roll on a stale reading repeated past its reset", () => {
    const stale = [
      sample(A, 15, 0.5, NOW - 10 * MINUTE),
      sample(A, 5, 0.5, NOW - 10 * MINUTE),
    ];
    expect(pooledConsumption(stale, [pooled(A)], NOW).pct).toBe(0);
    const fresh = pooledConsumption(
      [...stale, sample(A, 0, 0.02, FAR)],
      [pooled(A)],
      NOW,
    );
    expect(fresh.pct).toBeCloseTo(2, 6);
  });

  it("does not mistake an earlier dip for a drop after the reset", () => {
    const result = pooledConsumption(
      [
        sample(A, 25, 0.5, NOW - 10 * MINUTE),
        sample(A, 15, 0.49, NOW - 10 * MINUTE),
        sample(A, 5, 0.49, NOW - 10 * MINUTE),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("does not roll when the reset metadata disappears", () => {
    const result = pooledConsumption(
      [sample(A, 15, 0.5, NOW - 10 * MINUTE), sample(A, 5, 0.5, null)],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBe(0);
  });

  it("counts fresh burn after an expired baseline", () => {
    const result = pooledConsumption(
      [
        sample(A, 9, 0.5, NOW - 10 * MINUTE),
        sample(A, 5, 0.02, FAR),
        sample(A, 0, 0.03, FAR),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(3, 6);
  });

  it("adopts an expired reset first seen after a baseline without one", () => {
    const result = pooledConsumption(
      [
        sample(A, 20, 0.5, null),
        sample(A, 5, 0.5, NOW - 10 * MINUTE),
        sample(A, 0, 0.02, FAR),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
  });

  it("does not roll twice on one repeated expired reset", () => {
    const expired = NOW - 25 * MINUTE;
    const result = pooledConsumption(
      [
        sample(A, 40, 0.5, expired),
        sample(A, 30, 0.5, expired),
        sample(A, 20, 0.02, expired),
        sample(A, 15, 0.02, expired),
        sample(A, 10, 0.019, expired),
        sample(A, 0, 0.019, expired),
      ],
      [pooled(A)],
      NOW,
    );
    expect(result.pct).toBeCloseTo(2, 6);
  });

  it("uses each account's own window key", () => {
    const result = pooledConsumption(
      [
        sample(A, 30, 0.2, FAR, "primary"),
        sample(A, 0, 0.3, FAR, "primary"),
        sample(B, 30, 0.2, FAR, "secondary"),
        sample(B, 0, 0.22, FAR, "secondary"),
      ],
      [pooled(A, "primary"), pooled(B, "secondary")],
      NOW,
    );
    expect(result.pct).toBeCloseTo(6, 6);
  });
});

describe("codexWindowKeys", () => {
  const window = (
    slot: "primary" | "secondary",
    windowMinutes: number | null,
  ) => ({
    slot,
    windowMinutes,
    utilization: 0.1,
    resetAt: null,
    status: null,
    observedAt: 1,
    source: "usage" as const,
  });

  it("picks the longest window as weekly and the shortest as five-hour", () => {
    expect(
      codexWindowKeys([window("primary", 10_080), window("secondary", 300)]),
    ).toEqual({ weekly: "primary", short: "secondary" });
  });

  it("falls back to slots when window minutes are unknown", () => {
    expect(
      codexWindowKeys([window("primary", null), window("secondary", null)]),
    ).toEqual({ weekly: "secondary", short: "primary" });
  });

  it("does not label a lone known short window as weekly", () => {
    expect(
      codexWindowKeys([window("primary", 300), window("secondary", null)]),
    ).toEqual({ weekly: "secondary", short: "primary" });
    expect(codexWindowKeys([window("primary", 300)])).toEqual({
      weekly: null,
      short: "primary",
    });
  });

  it("pairs a lone known weekly window with the unknown-duration slot", () => {
    expect(
      codexWindowKeys([window("primary", null), window("secondary", 10_080)]),
    ).toEqual({ weekly: "secondary", short: "primary" });
    expect(
      codexWindowKeys([window("primary", 10_080), window("secondary", null)]),
    ).toEqual({ weekly: "primary", short: "secondary" });
  });

  it("treats a lone window as weekly with no short window", () => {
    expect(codexWindowKeys([window("primary", 10_080)])).toEqual({
      weekly: "primary",
      short: null,
    });
    expect(codexWindowKeys([])).toEqual({ weekly: null, short: null });
  });
});

function quota(overrides: Partial<AccountQuota> = {}): AccountQuota {
  return {
    accountId: A,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    ...overrides,
  };
}

describe("QuotaSampler and sample store", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
  });

  function setup() {
    const db = new Database(":memory:");
    databases.push(db);
    for (const migration of QUOTA_MIGRATIONS) db.exec(migration);
    let now = NOW;
    const samples = new QuotaSampleStore(db);
    const sampler = new QuotaSampler(samples, () => now);
    const quotas = new QuotaStore(db, sampler);
    return {
      db,
      samples,
      quotas,
      advance: (ms: number) => {
        now += ms;
      },
      rows: () =>
        db
          .prepare(
            "SELECT account_id, window_key, sampled_at, utilization, reset_at FROM pool_quota_sample ORDER BY sampled_at, window_key",
          )
          .all() as Array<{
          window_key: string;
          sampled_at: number;
          utilization: number;
          reset_at: number | null;
        }>,
    };
  }

  it("records every populated window of a put", () => {
    const { quotas, rows } = setup();
    quotas.put(
      quota({
        fiveHourUtilization: 0.1,
        fiveHourResetAt: NOW + HOUR,
        sevenDayUtilization: 0.2,
        sevenDayResetAt: FAR,
      }),
    );
    expect(rows()).toEqual([
      expect.objectContaining({ window_key: "five-hour", utilization: 0.1 }),
      expect.objectContaining({
        window_key: "seven-day",
        utilization: 0.2,
        reset_at: FAR,
      }),
    ]);
  });

  it("records a reset change even when utilization is unchanged", () => {
    const { quotas, samples, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.5, sevenDayResetAt: null }));
    advance(MINUTE);
    quotas.put(
      quota({ sevenDayUtilization: 0.5, sevenDayResetAt: NOW + 2 * MINUTE }),
    );
    advance(2 * MINUTE);
    quotas.put(quota({ sevenDayUtilization: 0.1, sevenDayResetAt: FAR }));
    const result = pooledConsumption(
      samples.list(),
      [pooled(A)],
      NOW + 3 * MINUTE,
    );
    expect(result.pct).toBeCloseTo(10, 6);
  });

  it("records Codex limit windows under their slot", () => {
    const { quotas, rows } = setup();
    quotas.put(
      quota({
        limitWindows: [
          {
            slot: "secondary",
            windowMinutes: 10_080,
            utilization: 0.3,
            resetAt: FAR,
            status: null,
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    );
    expect(rows()).toEqual([
      expect.objectContaining({ window_key: "secondary", utilization: 0.3 }),
    ]);
  });

  it("writes nothing for an unchanged value inside the heartbeat", () => {
    const { quotas, rows, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(SAMPLE_HEARTBEAT_MS - 1_000);
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    expect(rows()).toHaveLength(1);
  });

  it("writes a heartbeat row for an unchanged value after five minutes", () => {
    const { quotas, rows, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(SAMPLE_HEARTBEAT_MS);
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    expect(rows()).toHaveLength(2);
  });

  it("holds a changed value back until the minimum gap, then records it", () => {
    const { quotas, rows, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(SAMPLE_MIN_GAP_MS - 1_000);
    quotas.put(quota({ sevenDayUtilization: 0.21 }));
    expect(rows()).toHaveLength(1);
    advance(1_000);
    quotas.put(quota({ sevenDayUtilization: 0.21 }));
    expect(rows().map((row) => row.utilization)).toEqual([0.2, 0.21]);
  });

  it("skips windows without a utilization", () => {
    const { quotas, rows } = setup();
    quotas.put(quota());
    expect(rows()).toEqual([]);
  });

  it("resumes from the stored last row after a restart", () => {
    const { db, quotas, rows, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(MINUTE);
    const restarted = new QuotaStore(
      db,
      new QuotaSampler(new QuotaSampleStore(db), () => NOW + MINUTE),
    );
    restarted.put(quota({ sevenDayUtilization: 0.2 }));
    expect(rows()).toHaveLength(1);
  });

  it("deletes an account's samples on remove", () => {
    const { quotas, rows } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    quotas.put(quota({ accountId: B, sevenDayUtilization: 0.4 }));
    quotas.remove(A);
    expect(rows()).toEqual([expect.objectContaining({ utilization: 0.4 })]);
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    expect(rows()).toHaveLength(2);
  });

  it("prunes rows older than the retention on a later write", () => {
    const { quotas, rows, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(SAMPLE_RETENTION_MS + HOUR);
    quotas.put(quota({ sevenDayUtilization: 0.3 }));
    expect(rows().map((row) => row.utilization)).toEqual([0.3]);
  });

  it("never throws into the quota write when the history insert fails", () => {
    const { db, samples } = setup();
    const errors: unknown[] = [];
    let now = NOW;
    const quotas = new QuotaStore(
      db,
      new QuotaSampler(
        samples,
        () => now,
        (error) => errors.push(error),
      ),
    );
    db.exec("DROP TABLE pool_quota_sample");
    expect(() => quotas.put(quota({ sevenDayUtilization: 0.2 }))).not.toThrow();
    expect(quotas.get(A).sevenDayUtilization).toBe(0.2);
    now += MINUTE;
    quotas.put(quota({ sevenDayUtilization: 0.3 }));
    expect(errors).toHaveLength(1);
    now += 11 * MINUTE;
    quotas.put(quota({ sevenDayUtilization: 0.4 }));
    expect(errors).toHaveLength(2);
  });

  it("survives a failing error reporter and a failing account removal", () => {
    const { db, samples } = setup();
    const quotas = new QuotaStore(
      db,
      new QuotaSampler(
        samples,
        () => NOW,
        () => {
          throw new Error("reporter down");
        },
      ),
    );
    db.exec("DROP TABLE pool_quota_sample");
    expect(() => quotas.put(quota({ sevenDayUtilization: 0.2 }))).not.toThrow();
    expect(() => quotas.remove(A)).not.toThrow();
  });

  it("lists every retained row in time order", () => {
    const { samples, quotas, advance } = setup();
    quotas.put(quota({ sevenDayUtilization: 0.1 }));
    advance(30 * MINUTE);
    quotas.put(quota({ sevenDayUtilization: 0.2 }));
    advance(2 * HOUR);
    quotas.put(quota({ sevenDayUtilization: 0.3 }));
    expect(samples.list().map((row) => row.utilization)).toEqual([
      0.1, 0.2, 0.3,
    ]);
  });
});
