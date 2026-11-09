// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type { WikiPage, WikiPageSummary } from "../wiki-types.js";

const app = await loadPluginApp(() => import("../app.js"));
const tab = app.tabs.find((candidate) => candidate.id === "wiki")!;
afterEach(cleanup);

function summaryOf(id: string, title: string): WikiPageSummary {
  return {
    id,
    kind: "cuj",
    path: `docs/wiki/src/cujs/${id}.md`,
    title,
    status: "ruled",
    card: null,
    source: "ruling",
    updated: "2026-10-30",
  };
}

const first = summaryOf("cuj-first", "First journey");
const second = summaryOf("cuj-second", "Second journey");

function pageOf(summary: WikiPageSummary): WikiPage {
  return {
    ...summary,
    body: `# ${summary.title}\n\nBody of ${summary.id}.`,
    claims: [],
  };
}

function renderTab(rpc: Record<string, (input: unknown) => unknown>) {
  return renderSlot(
    tab as never,
    { threadId: "thr_1", environment: null } as never,
    {
      context: { projectId: "proj_a", threadId: "thr_1" },
      rpc: {
        projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
        pins: () => [],
        pinTasks: () => [],
        pinDecisions: () => [],
        ...rpc,
      },
    },
  );
}

describe("Design Wiki selection changes", () => {
  it("shows the latest selection when an earlier page answers late", async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    const slot = renderTab({
      list: () => ({
        state: "ready",
        message: null,
        pages: [first, second],
        errors: [],
      }),
      page: (input) => {
        const { pageId } = input as { pageId: string };
        if (pageId === "cuj-first") {
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { state: "found", page: pageOf(second) };
      },
    });
    await slot.findByRole("button", { name: "First journey" });
    fireEvent.click(slot.getByRole("button", { name: "First journey" }));
    await slot.findByText("Loading page…");
    fireEvent.click(slot.getByRole("button", { name: "Back to pages" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Second journey" }),
    );
    await slot.findByText("Body of cuj-second.");
    releaseFirst({ state: "found", page: pageOf(first) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slot.queryByText("Body of cuj-first.")).toBeNull();
    expect(slot.getByText("Body of cuj-second.")).toBeTruthy();
  });

  it("lets the reader leave a page that is still loading", async () => {
    const slot = renderTab({
      list: () => ({
        state: "ready",
        message: null,
        pages: [first],
        errors: [],
      }),
      page: () => new Promise(() => undefined),
    });
    await slot.findByRole("button", { name: "First journey" });
    fireEvent.click(slot.getByRole("button", { name: "First journey" }));
    await slot.findByText("Loading page…");
    fireEvent.click(slot.getByRole("button", { name: "Back to pages" }));
    await waitFor(() => {
      expect(slot.getByRole("button", { name: "First journey" })).toBeTruthy();
    });
  });
});

describe("Design Wiki partial discovery failure", () => {
  it("lists healthy pages and the unreadable file, and reports a missing page", async () => {
    const slot = renderTab({
      list: () => ({
        state: "ready",
        message: null,
        pages: [second],
        errors: [
          {
            kind: "cuj",
            path: "docs/wiki/src/cujs/first.md",
            message: "Could not read page: host busy",
          },
        ],
      }),
      page: () => ({ state: "missing" }),
    });
    await slot.findByRole("button", { name: "Second journey" });
    const error = slot.container.querySelector(
      "[data-wiki-error='docs/wiki/src/cujs/first.md']",
    );
    expect(error?.textContent).toContain("Could not read page: host busy");
    fireEvent.click(slot.getByRole("button", { name: "Second journey" }));
    await slot.findByText("That page no longer exists.");
    expect(slot.getByRole("button", { name: "Back to pages" })).toBeTruthy();
  });
});
