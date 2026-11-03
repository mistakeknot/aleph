// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WikiPage, WikiPageSummary } from "./wiki-types.js";

// Count renders of the shared browser per surface, using the real component.
const browserRenders = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("./ui/wiki-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/wiki-browser.js")>();
  return {
    ...actual,
    WikiBrowser: (props: Parameters<typeof actual.WikiBrowser>[0]) => {
      browserRenders.props.push(props);
      return actual.WikiBrowser(props);
    },
  };
});

const app = await loadPluginApp(() => import("./app.js"));
const navPanel = app.navPanels[0]!;
const tab = app.tabs.find((candidate) => candidate.id === "wiki")!;
afterEach(() => {
  cleanup();
  browserRenders.props.length = 0;
});

const pages: WikiPageSummary[] = [
  {
    id: "cuj-first",
    kind: "cuj",
    path: "docs/wiki/src/cujs/first.md",
    title: "First journey",
    status: "ruled",
    card: "ACME-12",
    source: "ruling",
    updated: "2026-10-30",
  },
  {
    id: "req-first",
    kind: "requirement",
    path: "docs/wiki/src/requirements/first.md",
    title: "First requirement",
    status: "open",
    card: null,
    source: "ruling",
    updated: "2026-10-30",
  },
];

const readyList = { state: "ready", message: null, pages, errors: [] };
const emptyList = {
  state: "empty",
  message: "This project has no docs/wiki/src directory yet.",
  pages: [],
  errors: [],
};

function page(): WikiPage {
  return {
    ...pages[0]!,
    body: "# First journey\n\n**Ruled — ACME-12** The reader opens the wiki.\n\n**Open** Who edits pages.",
    claims: [],
  };
}

function rpc(list: unknown = readyList) {
  return {
    projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
    list: () => list,
    page: (input: unknown) =>
      (input as { pageId: string }).pageId === "cuj-first"
        ? { state: "found", page: page() }
        : { state: "missing" },
  };
}

function renderTab(
  options: { projectId?: string | null; list?: unknown } = {},
) {
  return renderSlot(
    tab as never,
    { threadId: "thr_1", environment: null } as never,
    {
      context: {
        projectId:
          options.projectId === undefined ? "proj_a" : options.projectId,
        threadId: "thr_1",
      },
      rpc: rpc(options.list),
    },
  );
}

describe("Design Wiki thread side panel registration", () => {
  it("registers a fixed thread tab beside the nav panel", () => {
    expect(tab).toMatchObject({
      id: "wiki",
      title: "Design Wiki",
      icon: "BookOpen",
      availability: "fixed",
      context: { kind: "thread" },
    });
    expect(app.navPanels).toHaveLength(1);
  });
});

describe("Design Wiki thread side panel", () => {
  it("lists the thread's project pages without a project picker", async () => {
    const slot = renderTab();
    await slot.findByRole("region", { name: "Critical user journeys" });
    expect(slot.getByRole("region", { name: "Requirements" })).toBeTruthy();
    expect(slot.queryByRole("combobox", { name: "Project" })).toBeNull();
    const list = slot.rpcCalls.filter((call) => call.method === "list");
    expect(list.map((call) => call.input)).toEqual([{ projectId: "proj_a" }]);
  });

  it("opens a page inside the panel and returns to the list", async () => {
    const slot = renderTab();
    await slot.findByRole("region", { name: "Critical user journeys" });
    fireEvent.click(slot.getByRole("button", { name: "First journey" }));
    const article = await waitFor(() => {
      const node = slot.container.querySelector('[data-wiki-page="cuj-first"]');
      expect(node).not.toBeNull();
      return node!;
    });
    const claims = Array.from(article.querySelectorAll("[data-wiki-claim]"));
    expect(claims.map((node) => node.getAttribute("data-wiki-claim"))).toEqual([
      "ruled",
      "open",
    ]);
    expect(slot.navigateCalls).toEqual([]);
    expect(slot.queryByRole("region", { name: "Requirements" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Back to pages" }));
    await slot.findByRole("region", { name: "Requirements" });
    expect(slot.container.querySelector("[data-wiki-page]")).toBeNull();
  });

  it("says when the selected page no longer exists", async () => {
    const slot = renderTab({
      list: {
        ...readyList,
        pages: [{ ...pages[1]!, id: "cuj-gone", title: "Gone journey" }],
      },
    });
    await slot.findByRole("region", { name: "Requirements" });
    fireEvent.click(slot.getByRole("button", { name: "Gone journey" }));
    await slot.findByText("That page no longer exists.");
  });

  it("shows an empty state for a project without docs/wiki", async () => {
    const slot = renderTab({ list: emptyList });
    await slot.findByText("This project has no docs/wiki/src directory yet.");
    expect(slot.container.querySelector("[data-wiki-row]")).toBeNull();
  });

  it("shows an empty state for a thread without a project", async () => {
    const slot = renderTab({ projectId: null });
    await slot.findByText(
      "This thread has no project, so it has no design wiki.",
    );
    expect(slot.rpcCalls.some((call) => call.method === "list")).toBe(false);
  });
});

describe("shared browser", () => {
  it("renders the same WikiBrowser in the nav panel and the thread panel", async () => {
    const pageSlot = renderSlot(
      navPanel,
      { subPath: "proj_a" },
      { context: { projectId: null }, rpc: rpc() },
    );
    await pageSlot.findByRole("region", { name: "Critical user journeys" });
    const fromPage = browserRenders.props.length;
    expect(fromPage).toBeGreaterThan(0);
    cleanup();

    renderTab();
    await waitFor(() =>
      expect(browserRenders.props.length).toBeGreaterThan(fromPage),
    );
    const layouts = browserRenders.props.map(
      (props) => (props as { layout: string }).layout,
    );
    expect(new Set(layouts)).toEqual(new Set(["split", "stacked"]));
  });
});
