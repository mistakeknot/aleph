export function usageBarColorClass(usedPercent: number): string {
  if (usedPercent >= 95) return "bg-destructive";
  if (usedPercent >= 80) return "bg-warning";
  return "bg-primary";
}

export function formatUsageReset(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) return "Resetting now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
      ? `Resets in ${hours} hr`
      : `Resets in ${hours} hr ${remainingMinutes} min`;
  }
  const withinWeek = diffMs < 7 * 24 * 60 * 60_000;
  const formatted = reset.toLocaleString(undefined, {
    weekday: withinWeek ? "short" : undefined,
    month: withinWeek ? undefined : "short",
    day: withinWeek ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Resets ${formatted}`;
}

export function formatUsdCents(
  cents: number,
  alwaysShowCents: boolean,
): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: alwaysShowCents || cents % 100 !== 0 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatUsageDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

const HOUR_MS = 60 * 60_000;
const WINDOW_DURATION_MS = {
  "five-hour": 5 * HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
} as const;
const MIN_ELAPSED_FOR_BURN_MS = 10 * 60_000;
const MAX_OBSERVATION_AGE_MS = HOUR_MS;

export interface UsageBurn {
  percentPerHour: number;
  runsOutInMs: number | null;
}

interface ForecastWindow {
  kind?: "five-hour" | "daily" | "weekly" | "custom";
  usedPercent: number;
  resetsAt: string | null;
  observedAt?: number;
  limitReached?: boolean;
}

function hasReset(window: ForecastWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}

function usageLimitReached(window: ForecastWindow, now: number): boolean {
  return (
    !hasReset(window, now) &&
    (window.limitReached === true || window.usedPercent >= 100)
  );
}

export function usageBurnRate(
  window: ForecastWindow,
  now: number,
): UsageBurn | null {
  const { kind, observedAt, resetsAt, usedPercent } = window;
  if (kind === undefined || kind === "custom" || resetsAt === null) return null;
  if (usageLimitReached(window, now) || hasReset(window, now)) return null;
  if (observedAt === undefined || now - observedAt > MAX_OBSERVATION_AGE_MS)
    return null;
  const resetAt = Date.parse(resetsAt);
  const elapsedMs = WINDOW_DURATION_MS[kind] - (resetAt - observedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_ELAPSED_FOR_BURN_MS)
    return null;
  if (usedPercent > 0 && usedPercent < 2) return null;
  const percentPerHour = usedPercent / (elapsedMs / HOUR_MS);
  if (percentPerHour <= 0) return { percentPerHour, runsOutInMs: null };
  const runOutAt =
    observedAt + ((100 - usedPercent) / percentPerHour) * HOUR_MS;
  return {
    percentPerHour,
    runsOutInMs: runOutAt < resetAt ? runOutAt - now : null,
  };
}

export function describeUnavailableUsageBurn(
  window: ForecastWindow,
  now: number,
): string | null {
  if (hasReset(window, now)) return "Awaiting a reading after reset";
  if (usageLimitReached(window, now)) return "Last reading reached the limit";
  if (
    window.kind === undefined ||
    window.kind === "custom" ||
    window.resetsAt === null
  )
    return null;
  if (
    window.observedAt !== undefined &&
    now - window.observedAt > MAX_OBSERVATION_AGE_MS
  )
    return "Reading is too old to estimate";
  return "Insufficient quota data to estimate";
}

export function formatUsageBurnRate(percentPerHour: number): string {
  if (percentPerHour <= 0) return "0";
  if (percentPerHour < 0.05) return "<0.1";
  if (percentPerHour < 10) return String(Number(percentPerHour.toFixed(1)));
  return String(Math.round(percentPerHour));
}

export function usageProjectedPercent(
  window: ForecastWindow,
  burn: UsageBurn,
  now: number,
): number | null {
  if (window.resetsAt === null) return null;
  const remainingMs = Date.parse(window.resetsAt) - (window.observedAt ?? now);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return Math.min(
    100,
    window.usedPercent + burn.percentPerHour * (remainingMs / HOUR_MS),
  );
}

export function describeUsageBurn(burn: UsageBurn): string {
  if (burn.percentPerHour <= 0) return "No usage reported in the last reading";
  const rate = formatUsageBurnRate(burn.percentPerHour);
  const outlook =
    burn.runsOutInMs === null
      ? "projected to last until reset"
      : burn.runsOutInMs <= 0
        ? "projected limit time has passed"
        : `projected to run out in ${formatUsageDuration(burn.runsOutInMs)}`;
  return `Cycle average ${rate}%/hr from one reading · ${outlook}`;
}

interface ExhaustionSortable {
  refreshFailure?: string;
  usage: {
    status: string;
    windows?: readonly ForecastWindow[];
  } | null;
}

function exhaustionKey(
  account: ExhaustionSortable,
  now: number,
): { runsOutInMs: number; remainingPercent: number } {
  let runsOutInMs = Number.POSITIVE_INFINITY;
  let remainingPercent = 100;
  const windows =
    account.refreshFailure === undefined && account.usage?.status === "ok"
      ? (account.usage.windows ?? [])
      : [];
  for (const window of windows) {
    const burn = usageBurnRate(window, now);
    if (hasReset(window, now)) continue;
    if (usageLimitReached(window, now)) runsOutInMs = 0;
    else if (burn?.runsOutInMs != null)
      runsOutInMs = Math.min(runsOutInMs, Math.max(0, burn.runsOutInMs));
    remainingPercent = Math.min(remainingPercent, 100 - window.usedPercent);
  }
  return { runsOutInMs, remainingPercent };
}

export function sortAccountsByExhaustion<T extends ExhaustionSortable>(
  accounts: readonly T[],
  now: number,
): T[] {
  return accounts
    .map((account) => ({ account, key: exhaustionKey(account, now) }))
    .sort((a, b) =>
      a.key.runsOutInMs !== b.key.runsOutInMs
        ? a.key.runsOutInMs < b.key.runsOutInMs
          ? -1
          : 1
        : a.key.remainingPercent - b.key.remainingPercent,
    )
    .map(({ account }) => account);
}
