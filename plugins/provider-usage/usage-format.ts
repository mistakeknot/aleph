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

export interface UsageBurn {
  percentPerHour: number;
  runsOutInMs: number | null;
}

export function usageBurnRate(
  window: {
    kind?: "five-hour" | "daily" | "weekly" | "custom";
    usedPercent: number;
    resetsAt: string | null;
  },
  now: number,
): UsageBurn | null {
  if (window.kind === undefined || window.kind === "custom") return null;
  if (window.resetsAt === null) return null;
  const durationMs = WINDOW_DURATION_MS[window.kind];
  const remainingMs = new Date(window.resetsAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const elapsedMs = durationMs - remainingMs;
  if (elapsedMs < MIN_ELAPSED_FOR_BURN_MS) return null;
  const percentPerHour = window.usedPercent / (elapsedMs / HOUR_MS);
  if (window.usedPercent >= 100) return { percentPerHour, runsOutInMs: 0 };
  if (percentPerHour <= 0) return { percentPerHour, runsOutInMs: null };
  const runsOutInMs = ((100 - window.usedPercent) / percentPerHour) * HOUR_MS;
  return {
    percentPerHour,
    runsOutInMs: runsOutInMs < remainingMs ? runsOutInMs : null,
  };
}

export function describeUsageBurn(burn: UsageBurn): string {
  if (burn.percentPerHour <= 0) return "No usage yet this window";
  const rate =
    burn.percentPerHour < 10
      ? String(Number(burn.percentPerHour.toFixed(1)))
      : String(Math.round(burn.percentPerHour));
  const outlook =
    burn.runsOutInMs === null
      ? "lasts until reset"
      : burn.runsOutInMs <= 0
        ? "limit reached"
        : `runs out in ${formatUsageDuration(burn.runsOutInMs)}`;
  return `Burning ${rate}%/hr · ${outlook}`;
}
