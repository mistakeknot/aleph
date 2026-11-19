import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { AccountPoolHub } from "./hub.js";
import {
  registerUsageSource,
  usageFailureReason,
  usagePlan,
  usageWindowLabel,
} from "./usage-source.js";

it.each([
  ["invalid_grant: private upstream detail", "needs_sign_in"],
  ["private upstream connection detail", "unavailable"],
] as const)(
  "serializes a safe failure category at the usage RPC boundary",
  async (error, failureReason) => {
    const account = {
      id: "fixture",
      provider: "claude",
      kind: "oauth",
      accountUuid: null,
      email: null,
      label: "Primary",
      subscriptionType: null,
      rateLimitTier: null,
      limitWindows: [],
      familyWeekly: {},
      observedAt: 123,
      error,
    };
    const refreshUsage = vi.fn(async () => undefined);
    const hub = { status: async () => ({ accounts: [account] }), refreshUsage };
    const host = createFakePluginHost({ pluginId: "pool" });
    registerUsageSource(host.bb, hub as unknown as AccountPoolHub);
    try {
      const result = await host.harness.behavior.callRpc(
        "provider-usage.v1.getResource",
        { resourceId: "fixture", refresh: false },
      );
      expect(result).toMatchObject({
        failureReason,
        usage: {
          status: "error",
          message:
            "Usage could not be collected for this account. Try refreshing usage.",
        },
      });
      expect(JSON.stringify(result)).not.toContain(error);
      expect(refreshUsage).toHaveBeenCalledWith("fixture", false);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  },
);

it.each([
  ["OAuth refresh failed with HTTP 400. invalid_grant.", "needs_sign_in"],
  ["Refresh token expired", "needs_sign_in"],
  ["refresh_token_expired", "needs_sign_in"],
  ["Network unavailable", "unavailable"],
  [null, undefined],
] as const)("categorizes refresh failures safely", (error, expected) => {
  expect(usageFailureReason(error)).toBe(expected);
});

describe("usage presentation labels", () => {
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });
  it("names Claude plans after the Max and Ultra rename", () => {
    expect(
      usagePlan({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toEqual({ id: "ultra", label: "Ultra" });
    expect(
      usagePlan({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      }),
    ).toEqual({ id: "max", label: "Max" });
    expect(usagePlan({ subscriptionType: "max", rateLimitTier: null })).toEqual(
      { id: "max", label: "Max" },
    );
    expect(usagePlan({ subscriptionType: "pro", rateLimitTier: null })).toEqual(
      { id: "pro", label: "Pro" },
    );
    expect(
      usagePlan({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });
});
