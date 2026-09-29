import { formatUsageDuration } from "./usage-format.js";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

export interface HeaderQuota {
  providerId: string;
  displayName: string;
  provider: UsageProvider;
  usedPercent: number;
  reset: string | null;
  tone: "warning" | "critical" | null;
}

function usageTone(usedPercent: number): HeaderQuota["tone"] {
  if (usedPercent >= 95) return "critical";
  return usedPercent >= 80 ? "warning" : null;
}

export function formatHeaderReset(
  resetsAt: string | null,
  now: number,
): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - now;
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return "now";
  const [head = ""] = formatUsageDuration(remaining).split(" ");
  return head;
}

export function summarizeHeaderQuotas(
  machine: UsageMachine | null,
  now: number,
): HeaderQuota[] {
  const byProvider = new Map<string, HeaderQuota>();
  for (const account of machine?.providers ?? []) {
    if (account.usage?.status !== "ok") continue;
    for (const window of account.usage.windows) {
      const current = byProvider.get(account.providerId);
      if (current !== undefined && current.usedPercent >= window.usedPercent)
        continue;
      byProvider.set(account.providerId, {
        providerId: account.providerId,
        displayName: account.displayName,
        provider: account,
        usedPercent: window.usedPercent,
        reset: formatHeaderReset(window.resetsAt, now),
        tone: usageTone(window.usedPercent),
      });
    }
  }
  return [...byProvider.values()];
}
