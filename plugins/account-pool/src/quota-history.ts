import type { AccountQuota, LimitWindow } from "./contracts.js";
import type { QuotaSampleStore } from "./store.js";

export type SampleWindowKey =
  | "five-hour"
  | "seven-day"
  | "primary"
  | "secondary";

export interface QuotaSample {
  accountId: string;
  windowKey: SampleWindowKey;
  sampledAt: number;
  utilization: number;
  resetAt: number | null;
}

export const BURN_WINDOW_MS = 60 * 60 * 1_000;
export const SAMPLE_MIN_GAP_MS = 15_000;
export const SAMPLE_HEARTBEAT_MS = 5 * 60 * 1_000;
export const SAMPLE_RETENTION_MS = 26 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 10 * 60 * 1_000;

interface LastWrite {
  utilization: number;
  writtenAt: number;
}

function quotaWindows(quota: AccountQuota): Array<{
  windowKey: SampleWindowKey;
  utilization: number | null;
  resetAt: number | null;
}> {
  return [
    {
      windowKey: "five-hour",
      utilization: quota.fiveHourUtilization,
      resetAt: quota.fiveHourResetAt,
    },
    {
      windowKey: "seven-day",
      utilization: quota.sevenDayUtilization,
      resetAt: quota.sevenDayResetAt,
    },
    ...quota.limitWindows.map((window) => ({
      windowKey: window.slot,
      utilization: window.utilization,
      resetAt: window.resetAt,
    })),
  ];
}

export class QuotaSampler {
  private readonly last = new Map<string, LastWrite>();
  private lastPruneAt = 0;

  constructor(
    private readonly store: QuotaSampleStore,
    private readonly now: () => number = Date.now,
  ) {}

  record(quota: AccountQuota): void {
    const now = this.now();
    for (const window of quotaWindows(quota)) {
      if (window.utilization === null) continue;
      const key = `${quota.accountId}:${window.windowKey}`;
      let last = this.last.get(key);
      if (last === undefined) {
        const stored = this.store.last(quota.accountId, window.windowKey);
        if (stored !== null)
          last = {
            utilization: stored.utilization,
            writtenAt: stored.sampledAt,
          };
      }
      const elapsed = last === undefined ? Infinity : now - last.writtenAt;
      const changed = last?.utilization !== window.utilization;
      const due = changed
        ? elapsed >= SAMPLE_MIN_GAP_MS
        : elapsed >= SAMPLE_HEARTBEAT_MS;
      if (!due) {
        if (last !== undefined) this.last.set(key, last);
        continue;
      }
      this.store.insert({
        accountId: quota.accountId,
        windowKey: window.windowKey,
        sampledAt: now,
        utilization: window.utilization,
        resetAt: window.resetAt,
      });
      this.last.set(key, { utilization: window.utilization, writtenAt: now });
    }
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      this.store.prune(now - SAMPLE_RETENTION_MS);
    }
  }

  forget(accountId: string): void {
    for (const key of this.last.keys())
      if (key.startsWith(`${accountId}:`)) this.last.delete(key);
    this.store.removeAccount(accountId);
  }
}

export function codexWindowKeys(windows: readonly LimitWindow[]): {
  weekly: SampleWindowKey | null;
  short: SampleWindowKey | null;
} {
  const known = windows.filter((window) => window.windowMinutes !== null);
  if (known.length >= 2) {
    const sorted = [...known].sort(
      (left, right) => (right.windowMinutes ?? 0) - (left.windowMinutes ?? 0),
    );
    const longest = sorted[0]!;
    const shortest = sorted[sorted.length - 1]!;
    return {
      weekly: longest.slot,
      short:
        shortest.windowMinutes === longest.windowMinutes ? null : shortest.slot,
    };
  }
  if (known.length === 1) return { weekly: known[0]!.slot, short: null };
  const slots = new Set(windows.map((window) => window.slot));
  if (slots.has("secondary"))
    return {
      weekly: "secondary",
      short: slots.has("primary") ? "primary" : null,
    };
  if (slots.has("primary")) return { weekly: "primary", short: null };
  return { weekly: null, short: null };
}

export interface PooledAccount {
  id: string;
  label: string;
  windowKey: SampleWindowKey | null;
}

export interface PooledConsumption {
  pct: number | null;
  accounts: Array<{ id: string; label: string; pct: number }>;
}

function roundPct(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function accountConsumed(
  samples: readonly QuotaSample[],
  start: number,
): number {
  const baselineIndex = samples.reduce(
    (found, entry, index) => (entry.sampledAt <= start ? index : found),
    -1,
  );
  const from = Math.max(baselineIndex, 0);
  let previous = samples[from]!;
  let highWater = previous.utilization;
  let consumed = 0;
  for (const current of samples.slice(from + 1)) {
    const rolled =
      previous.resetAt !== null && current.sampledAt >= previous.resetAt;
    if (rolled) highWater = 0;
    if (current.utilization > highWater) {
      const increase = current.utilization - highWater;
      const span = current.sampledAt - previous.sampledAt;
      const overlap = current.sampledAt - Math.max(previous.sampledAt, start);
      consumed += span <= 0 ? increase : (increase * overlap) / span;
      highWater = current.utilization;
    }
    previous = current;
  }
  return consumed;
}

export function pooledConsumption(
  samples: readonly QuotaSample[],
  accounts: readonly PooledAccount[],
  now: number,
): PooledConsumption {
  const start = now - BURN_WINDOW_MS;
  const results: PooledConsumption["accounts"] = [];
  let anyPair = false;
  for (const account of accounts) {
    const key = account.windowKey;
    if (key === null) continue;
    const own = samples
      .filter(
        (entry) =>
          entry.accountId === account.id &&
          entry.windowKey === key &&
          entry.sampledAt <= now,
      )
      .sort((left, right) => left.sampledAt - right.sampledAt);
    if (own.length === 0) continue;
    if (own.length >= 2) anyPair = true;
    results.push({
      id: account.id,
      label: account.label,
      pct: roundPct(accountConsumed(own, start) * 100),
    });
  }
  if (!anyPair || results.length === 0) return { pct: null, accounts: results };
  const total = results.reduce((sum, entry) => sum + entry.pct, 0);
  return { pct: roundPct(total / results.length), accounts: results };
}
