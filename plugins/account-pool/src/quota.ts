import type {
  Account,
  AccountQuota,
  AccountSummary,
  FamilyQuota,
  FamilyWeekly,
  LimitWindow,
  ModelFamily,
  SwitchReason,
} from "./contracts.js";

const PREFIX = "anthropic-ratelimit-unified-";
const SCOPED_HEADER =
  /^anthropic-ratelimit-unified-7d_(.+)-(utilization|reset|status)$/u;

interface ScopedHeaderValues {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function epochMilliseconds(value: number): number {
  return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
}

export function parseReset(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return epochMilliseconds(value);
  }
  if (value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return epochMilliseconds(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return "other";
  const normalized = model.toLowerCase();
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return "other";
}

function scopedHeaderValues(headers: Headers): ScopedHeaderValues | null {
  const buckets = new Map<string, ScopedHeaderValues>();
  for (const [name, value] of headers) {
    const match = SCOPED_HEADER.exec(name.toLowerCase());
    const bucket = match?.[1];
    const field = match?.[2];
    if (bucket === undefined || field === undefined) continue;
    const current = buckets.get(bucket) ?? {
      utilization: null,
      resetAt: null,
      status: null,
    };
    if (field === "utilization") current.utilization = parseNumber(value);
    if (field === "reset") current.resetAt = parseReset(value);
    if (field === "status") current.status = value;
    buckets.set(bucket, current);
  }
  return [...buckets.values()][0] ?? null;
}

export interface WindowReading {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
}

export function isPastReset(resetAt: number | null, now: number): boolean {
  return resetAt !== null && resetAt <= now;
}

export function mergeWindow(
  fresh: WindowReading,
  previous: WindowReading,
  now: number,
): WindowReading {
  const retained = isPastReset(previous.resetAt, now)
    ? { utilization: null, resetAt: null, status: null }
    : previous;
  return {
    utilization: fresh.utilization ?? retained.utilization,
    resetAt: fresh.resetAt ?? retained.resetAt,
    status: fresh.status ?? retained.status,
  };
}

export function expireFamilyQuota(
  quota: FamilyQuota | null,
  now: number,
): FamilyQuota | null {
  return quota !== null && isPastReset(quota.resetAt, now) ? null : quota;
}

export function expireFamilyWeekly(
  weekly: FamilyWeekly,
  now: number,
): FamilyWeekly {
  return {
    fable: expireFamilyQuota(weekly.fable, now),
    sonnet: expireFamilyQuota(weekly.sonnet, now),
    opus: expireFamilyQuota(weekly.opus, now),
    haiku: expireFamilyQuota(weekly.haiku, now),
    other: expireFamilyQuota(weekly.other, now),
  };
}

export function quotaFromHeaders(
  accountId: string,
  headers: Headers,
  previous: AccountQuota,
  family: ModelFamily,
  now: number,
): AccountQuota {
  const fiveHourUtilization = parseNumber(
    headers.get(`${PREFIX}5h-utilization`),
  );
  const fiveHourResetAt = parseReset(headers.get(`${PREFIX}5h-reset`));
  const fiveHourStatus = headers.get(`${PREFIX}5h-status`);
  const sevenDayUtilization = parseNumber(
    headers.get(`${PREFIX}7d-utilization`),
  );
  const sevenDayResetAt = parseReset(headers.get(`${PREFIX}7d-reset`));
  const sevenDayStatus = headers.get(`${PREFIX}7d-status`);
  const representativeClaim = headers.get(`${PREFIX}representative-claim`);
  const overageStatus = headers.get(`${PREFIX}overage-status`);
  const extraUsage: AccountQuota["extraUsage"] =
    overageStatus === "allowed" ||
    overageStatus === "allowed_warning" ||
    overageStatus === "rejected"
      ? {
          status: overageStatus === "rejected" ? "rejected" : "allowed",
          observedAt: now,
          source: "header",
        }
      : previous.extraUsage;
  const scoped = scopedHeaderValues(headers);
  const retainedWeekly = expireFamilyWeekly(previous.familyWeekly, now);
  const priorFamily = retainedWeekly[family];
  const familyWeekly: AccountQuota["familyWeekly"] =
    scoped === null
      ? retainedWeekly
      : {
          ...retainedWeekly,
          [family]: {
            utilization: scoped.utilization ?? priorFamily?.utilization ?? null,
            resetAt: scoped.resetAt ?? priorFamily?.resetAt ?? null,
            status: scoped.status ?? priorFamily?.status ?? null,
            observedAt: now,
            source: "header",
          },
        };
  const fiveHour = mergeWindow(
    {
      utilization: fiveHourUtilization,
      resetAt: fiveHourResetAt,
      status: fiveHourStatus,
    },
    {
      utilization: previous.fiveHourUtilization,
      resetAt: previous.fiveHourResetAt,
      status: previous.fiveHourStatus,
    },
    now,
  );
  const sevenDay = mergeWindow(
    {
      utilization: sevenDayUtilization,
      resetAt: sevenDayResetAt,
      status: sevenDayStatus,
    },
    {
      utilization: previous.sevenDayUtilization,
      resetAt: previous.sevenDayResetAt,
      status: previous.sevenDayStatus,
    },
    now,
  );
  const observed =
    fiveHourUtilization !== null ||
    fiveHourResetAt !== null ||
    fiveHourStatus !== null ||
    sevenDayUtilization !== null ||
    sevenDayResetAt !== null ||
    sevenDayStatus !== null ||
    representativeClaim !== null ||
    extraUsage !== previous.extraUsage ||
    scoped !== null;
  return {
    accountId,
    usageRestriction: previous.usageRestriction,
    extraUsage,
    fiveHourUtilization: fiveHour.utilization,
    fiveHourResetAt: fiveHour.resetAt,
    fiveHourStatus: fiveHour.status,
    sevenDayUtilization: sevenDay.utilization,
    sevenDayResetAt: sevenDay.resetAt,
    sevenDayStatus: sevenDay.status,
    representativeClaim: representativeClaim ?? previous.representativeClaim,
    familyWeekly,
    limitWindows: previous.limitWindows,
    observedAt: observed ? now : previous.observedAt,
    heldUntil: previous.heldUntil,
    error: previous.error,
  };
}

interface QuotaWindow {
  utilization: number | null;
  status: string | null;
  resetAt: number | null;
}

function quotaWindows(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
): QuotaWindow[] {
  const familyQuota = family === null ? null : quota.familyWeekly[family];
  return [
    {
      utilization: quota.fiveHourUtilization,
      status: quota.fiveHourStatus,
      resetAt: quota.fiveHourResetAt,
    },
    {
      utilization: quota.sevenDayUtilization,
      status: quota.sevenDayStatus,
      resetAt: quota.sevenDayResetAt,
    },
    ...quota.limitWindows,
    ...(familyQuota === null ? [] : [familyQuota]),
  ];
}

function isRefusedWindow(window: QuotaWindow, now: number): boolean {
  if (window.resetAt !== null && window.resetAt <= now) return false;
  if (window.status !== null) return window.status.toLowerCase() === "rejected";
  return window.utilization !== null && window.utilization >= 1;
}

function isWindowPastThreshold(
  window: QuotaWindow,
  threshold: number,
  now: number,
): boolean {
  if (window.resetAt !== null && window.resetAt <= now) return false;
  return (
    isRefusedWindow(window, now) ||
    (window.utilization !== null && window.utilization >= threshold)
  );
}

export function blockingResetAt(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  now: number,
): number | null {
  if (isUsageRestricted(quota, now))
    return quota.usageRestriction?.resetAt ?? null;
  let latest: number | null = null;
  for (const window of quotaWindows(quota, family)) {
    if (!isRefusedWindow(window, now)) continue;
    if (window.resetAt === null) return null;
    latest = Math.max(latest ?? window.resetAt, window.resetAt);
  }
  return latest;
}

export function isQuotaExhausted(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  now: number,
): boolean {
  return (
    isUsageRestricted(quota, now) ||
    quotaWindows(quota, family).some((window) => isRefusedWindow(window, now))
  );
}

export function isPastThreshold(
  quota: AccountQuota,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): boolean {
  return (
    isUsageRestricted(quota, now) ||
    quotaWindows(quota, family).some((window) =>
      isWindowPastThreshold(window, threshold, now),
    )
  );
}

export function longestLimitWindow(
  windows: readonly LimitWindow[],
): LimitWindow | null {
  let longest: LimitWindow | null = null;
  for (const window of windows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }
  return longest;
}

export function isUsageRestricted(
  quota: AccountQuota | AccountSummary,
  now: number,
): boolean {
  return (
    quota.usageRestriction !== null &&
    (quota.usageRestriction.resetAt === null ||
      quota.usageRestriction.resetAt > now)
  );
}

export function hasExtraUsage(quota: AccountQuota): boolean {
  return (
    quota.extraUsage?.status === "allowed" && quota.usageRestriction === null
  );
}

export function isQuotaRejection(headers: Headers): boolean {
  for (const [name, value] of headers) {
    if (value.toLowerCase() !== "rejected") continue;
    const normalized = name.toLowerCase();
    if (
      normalized === `${PREFIX}5h-status` ||
      normalized === `${PREFIX}7d-status` ||
      SCOPED_HEADER.test(normalized)
    )
      return true;
  }
  return false;
}

export function governingWeeklyResetAt(
  quota: AccountQuota,
  family: ModelFamily,
): number | null {
  return (
    quota.familyWeekly[family]?.resetAt ??
    quota.sevenDayResetAt ??
    longestLimitWindow(quota.limitWindows)?.resetAt ??
    null
  );
}

export function accountStatus(
  account: Account,
  quota: AccountQuota,
  now: number,
): AccountSummary["status"] {
  if (!account.enabled) return "disabled";
  if (quota.error !== null) return "error";
  if (quota.heldUntil !== null && quota.heldUntil > now) return "held";
  if (isUsageRestricted(quota, now)) return "exhausted";
  if (isQuotaExhausted(quota, null, now) && !hasExtraUsage(quota))
    return "exhausted";
  return "ready";
}

export function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - now);
}

export function usagePercent(
  quota: AccountQuota,
  family: ModelFamily | null,
  now: number,
): number | null {
  let highest: number | null = null;
  const include = (utilization: number | null, resetAt: number | null) => {
    if (utilization === null || (resetAt !== null && resetAt <= now)) return;
    highest = Math.max(highest ?? utilization, utilization);
  };
  include(quota.fiveHourUtilization, quota.fiveHourResetAt);
  include(quota.sevenDayUtilization, quota.sevenDayResetAt);
  for (const window of quota.limitWindows)
    include(window.utilization, window.resetAt);
  const familyQuota = family === null ? null : quota.familyWeekly[family];
  if (familyQuota !== null)
    include(familyQuota.utilization, familyQuota.resetAt);
  return highest === null ? null : Math.round(highest * 1000) / 10;
}

export function switchReason(
  account: Account | undefined,
  quota: AccountQuota,
  family: ModelFamily,
  threshold: number,
  now: number,
): SwitchReason {
  if (account === undefined || !account.enabled || quota.error !== null)
    return "account_unavailable";
  if (isQuotaExhausted(quota, family, now)) return "limit_reached";
  if (isPastThreshold(quota, family, threshold, now))
    return "threshold_crossed";
  return "other";
}
