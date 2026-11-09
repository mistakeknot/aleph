// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type { WikiPage, WikiPageSummary } from "../wiki-types.js";

const app = await loadPluginApp(() => import("../app.js"));
const registration = app.navPanels[0]!;
afterEach(cleanup);

const LONG_TITLE =
  "A deliberately long journey title that must stay readable in the narrowest list column";

const summary: WikiPageSummary = {
  id: "cuj-long-identifier",
  kind: "cuj",
  path: "docs/wiki/src/cujs/long.md",
  title: LONG_TITLE,
  status: "ruled",
  card: "ACME-12",
  source: "ruling",
  updated: "2026-10-30",
};

const readyList = {
  state: "ready" as const,
  message: null,
  pages: [summary],
  errors: [],
};

const foundPage: WikiPage = {
  ...summary,
  body: "# Long\n\nBody text.",
  claims: [],
};

function never(): Promise<never> {
  return new Promise(() => undefined);
}

function render(
  subPath: string,
  rpc: Record<string, (input: unknown) => unknown>,
) {
  return renderSlot(
    registration,
    { subPath },
    { context: { projectId: "proj_a" }, rpc },
  );
}

function count(slot: { rpcCalls: { method: string }[] }, method: string) {
  return slot.rpcCalls.filter((call) => call.method === method).length;
}

describe("Design Wiki browser loading", () => {
  it("requests the page while the list is still loading", async () => {
    const slot = render("proj_a/cuj-long-identifier", {
      projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
      list: () => never(),
      page: () => ({ state: "found", page: foundPage }),
      pins: () => [],
      pinTasks: () => [],
      pinDecisions: () => [],
    });
    await slot.findByText("Body text.");
    slot.getByText("Loading wiki…");
    expect(count(slot, "page")).toBeGreaterThan(0);
  });

  it("asks for the list once per load and does not refetch it", async () => {
    const slot = render("proj_a/cuj-long-identifier", {
      projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
      list: () => readyList,
      page: () => ({ state: "found", page: foundPage }),
      pins: () => [],
      pinTasks: () => [],
      pinDecisions: () => [],
    });
    await slot.findByText("Body text.");
    await slot.findByRole("region", { name: "Critical user journeys" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(count(slot, "list")).toBe(1);
    expect(count(slot, "page")).toBe(1);
  });
});

describe("Design Wiki list row", () => {
  it("keeps the title on its own line above a single truncated meta line", async () => {
    const slot = render("proj_a", {
      projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
      list: () => readyList,
      pins: () => [],
    });
    const row = await slot.findByRole("button", { name: LONG_TITLE });
    const item = row.closest("li")!;
    expect(item.className).toContain("flex-col");
    expect(item.className).not.toContain("flex-wrap");
    expect(row.className).toContain("w-full");
    expect(row.className).toContain("text-foreground");
    expect(row.className).not.toContain("truncate");
    const meta = item.querySelector("[data-wiki-meta]")!;
    expect(meta.contains(row)).toBe(false);
    expect(meta.className).toContain("overflow-hidden");
    expect(meta.className).toContain("whitespace-nowrap");
    expect(meta.className).toContain("text-subtle-foreground");
    expect(meta.textContent).toContain("cuj-long-identifier");
    expect(meta.textContent).toContain("Ruled");
    expect(meta.textContent).toContain("ACME-12");
    expect(meta.textContent).toContain("2026-10-30");
  });

  it("colours the Ruled badge with the readable success text token", async () => {
    const slot = render("proj_a", {
      projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
      list: () => readyList,
      pins: () => [],
    });
    await slot.findByRole("button", { name: LONG_TITLE });
    const pill = slot.container.querySelector("[data-wiki-status='ruled']")!;
    expect(pill.className).toContain("text-success-foreground");
    expect(pill.className.split(/\s+/)).not.toContain("text-success");
  });
});
