import { describe, expect, it } from "vitest";
import { formatHeaderReset, summarizeHeaderQuotas } from "./usage-header.js";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

const NOW = Date.parse("2026-09-29T00:00:00.000Z");

function account(
  providerId: string,
  displayName: string,
  windows: { label: string; usedPercent: number; resetsAt: string | null }[],
  status: "ok" | "expired" = "ok",
  id = `${providerId}-account`,
): UsageProvider {
  return {
    id,
    providerId,
    accountLabel: null,
    displayName,
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage:
      status === "ok"
        ? {
            status: "ok",
            accountEmail: null,
            planLabel: null,
            windows: windows.map((window) => ({ ...window, cost: null })),
          }
        : { status: "expired" },
  };
}

function machine(providers: UsageProvider[]): UsageMachine {
  return {
    id: "host",
    displayName: "Host",
    status: "connected",
    providers,
    error: null,
  };
}

describe("formatHeaderReset", () => {
  it.each([
    [30 * 60_000, "30m"],
    [5 * 60 * 60_000, "5h"],
    [5 * 24 * 60 * 60_000 + 3 * 60 * 60_000, "5d"],
    [-1, "now"],
  ])("renders %ims as %s", (offset, expected) => {
    expect(formatHeaderReset(new Date(NOW + offset).toISOString(), NOW)).toBe(
      expected,
    );
  });

  it("returns null without a reset time or with an unparseable one", () => {
    expect(formatHeaderReset(null, NOW)).toBeNull();
    expect(formatHeaderReset("later", NOW)).toBeNull();
  });
});

describe("summarizeHeaderQuotas", () => {
  it("reports each provider's tightest window across its accounts", () => {
    const week = new Date(NOW + 5 * 24 * 60 * 60_000).toISOString();
    const quotas = summarizeHeaderQuotas(
      machine([
        account("claude-code", "Claude Code", [
          { label: "Five-hour limit", usedPercent: 10, resetsAt: null },
          { label: "Weekly limit", usedPercent: 22.4, resetsAt: week },
        ]),
        account(
          "claude-code",
          "Claude Code",
          [{ label: "Weekly limit", usedPercent: 60, resetsAt: week }],
          "ok",
          "claude-second",
        ),
        account("codex", "Codex", [
          { label: "Weekly limit", usedPercent: 25, resetsAt: week },
        ]),
      ]),
      NOW,
    );
    expect(
      quotas.map((quota) => [quota.providerId, quota.usedPercent]),
    ).toEqual([
      ["claude-code", 60],
      ["codex", 25],
    ]);
    expect(quotas[1]).toMatchObject({
      displayName: "Codex",
      reset: "5d",
      tone: null,
    });
  });

  it("skips providers with no reported window and flags high usage", () => {
    const quotas = summarizeHeaderQuotas(
      machine([
        account("claude-code", "Claude Code", [], "expired"),
        account("codex", "Codex", [
          { label: "Weekly limit", usedPercent: 96, resetsAt: null },
        ]),
      ]),
      NOW,
    );
    expect(quotas).toHaveLength(1);
    expect(quotas[0]).toMatchObject({ tone: "critical", reset: null });
  });

  it("is empty without a machine", () => {
    expect(summarizeHeaderQuotas(null, NOW)).toEqual([]);
  });
});
