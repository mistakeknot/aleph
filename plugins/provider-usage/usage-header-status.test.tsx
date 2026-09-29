// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  loadPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import {
  headerQuotaDetail,
  ProviderUsageHeaderQuotas,
} from "./usage-header-status.js";
import type { HeaderQuota } from "./usage-header.js";
import type { UsageProvider } from "./usage-schema.js";

function usageProvider(id: string, glyph: string): UsageProvider {
  return {
    id,
    providerId: id,
    accountLabel: null,
    displayName: id,
    logoUrl: null,
    icon: { glyph },
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: null,
  };
}

beforeAll(() => {
  installTestPluginRuntime();
});

afterEach(() => {
  cleanup();
});

function quota(overrides: Partial<HeaderQuota> = {}): HeaderQuota {
  return {
    providerId: "claude-code",
    displayName: "Claude Code",
    provider: usageProvider("claude-code", "C"),
    usedPercent: 22,
    reset: "5d",
    tone: null,
    ...overrides,
  };
}

const codex = quota({
  providerId: "codex",
  displayName: "Codex",
  provider: usageProvider("codex", "X"),
  usedPercent: 25,
});

function renderQuotas(quotas: HeaderQuota[], width = 600, compact = false) {
  return render(
    <ProviderUsageHeaderQuotas
      quotas={quotas}
      availableWidth={width}
      isCompactViewport={compact}
      renderPanel={() => <div>usage panel</div>}
    />,
  );
}

describe("header quota detail", () => {
  it("collapses from full to percent to the worst provider as width shrinks", () => {
    expect(headerQuotaDetail(2, 400, false)).toBe("full");
    expect(headerQuotaDetail(2, 400, true)).toBe("percent");
    expect(headerQuotaDetail(2, 120, false)).toBe("percent");
    expect(headerQuotaDetail(2, 80, false)).toBe("worst");
  });
});

describe("ProviderUsageHeaderQuotas", () => {
  it("renders an icon per provider with the name as label and tooltip, plus percent and window", () => {
    const view = renderQuotas([quota(), codex]);
    const claude = view.getByRole("img", { name: "Claude Code" });
    expect(claude.getAttribute("title")).toBe("Claude Code");
    expect(view.getByRole("img", { name: "Codex" }).getAttribute("title")).toBe(
      "Codex",
    );
    expect(view.getByText("22%")).toBeTruthy();
    expect(view.getByText("25%")).toBeTruthy();
    expect(view.getAllByText("5d")).toHaveLength(2);
    expect(view.queryByText("Claude Code")).toBeNull();
  });

  it("renders nothing when there are no quotas", () => {
    const view = renderQuotas([]);
    expect(view.container.innerHTML).toBe("");
  });

  it("drops the reset window on a compact viewport and shows only the worst provider when very narrow", () => {
    const compact = renderQuotas([quota(), codex], 200, true);
    expect(compact.queryByText("5d")).toBeNull();
    expect(compact.getByText("22%")).toBeTruthy();
    cleanup();
    const narrow = renderQuotas([quota(), codex], 60);
    expect(narrow.queryByText("22%")).toBeNull();
    expect(narrow.getByText("25%")).toBeTruthy();
    expect(narrow.getByRole("img", { name: "Codex" })).toBeTruthy();
  });

  it("opens the panel downward on keyboard focus and closes on blur", async () => {
    const view = renderQuotas([quota(), codex]);
    const trigger = view.getByTestId("provider-usage-header-status");
    fireEvent.focus(trigger);
    const panel = await view.findByText("usage panel");
    expect(panel.closest("[data-side]")?.getAttribute("data-side")).toBe(
      "bottom",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(trigger);
    await waitFor(() => expect(view.queryByText("usage panel")).toBeNull());
  });

  it("toggles the panel on tap so touch devices without hover can open and close it", async () => {
    const view = renderQuotas([quota()]);
    const trigger = view.getByTestId("provider-usage-header-status");
    fireEvent.click(trigger);
    expect(await view.findByText("usage panel")).toBeTruthy();
    fireEvent.click(trigger);
    await waitFor(() => expect(view.queryByText("usage panel")).toBeNull());
  });

  it("marks warning and critical quotas with tone colors", () => {
    const view = renderQuotas([
      quota({ usedPercent: 85, tone: "warning" }),
      codex.usedPercent === 25
        ? { ...codex, usedPercent: 97, tone: "critical" }
        : codex,
    ]);
    expect(view.getByText("85%").className).toContain("text-warning-text");
    expect(view.getByText("97%").className).toContain("text-destructive-text");
  });
});

describe("provider usage app header slot", () => {
  it("registers a header status slot and drops the account pooler one", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    expect(app.appHeaderStatuses.map((slot) => slot.id)).toEqual(["quota"]);
  });
});
