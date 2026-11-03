// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { parseWikiLocation } from "./app.js";
import type { WikiPage, WikiPageSummary } from "./wiki-types.js";

const app = await loadPluginApp(() => import("./app.js"));
const registration = app.navPanels[0]!;
afterEach(cleanup);

function summary(overrides: Partial<WikiPageSummary>): WikiPageSummary {
  return {
    id: "cuj-first",
    kind: "cuj",
    path: "docs/wiki/src/cujs/first.md",
    title: "First journey",
    status: "ruled",
    card: "ACME-12",
    source: "ruling",
    updated: "2026-10-30",
    ...overrides,
  };
}

const pages: WikiPageSummary[] = [
  summary({}),
  summary({
    id: "cuj-second",
    path: "docs/wiki/src/cujs/second.md",
    title: "Second journey",
    status: "open",
    card: null,
  }),
  summary({
    id: "req-first",
    kind: "requirement",
    path: "docs/wiki/src/requirements/first.md",
    title: "First requirement",
    status: "design-choice",
    card: null,
  }),
];

const projects = [
  { id: "proj_a", name: "Alpha", hasCheckout: true },
  { id: "proj_b", name: "Beta", hasCheckout: false },
];

function readyList() {
  return {
    state: "ready" as const,
    message: null,
    pages,
    errors: [
      {
        kind: "requirement" as const,
        path: "docs/wiki/src/requirements/broken.md",
        message: "Missing front matter field: status",
      },
    ],
  };
}

function page(): WikiPage {
  return {
    ...pages[0]!,
    body: [
      "# First journey",
      "",
      "**Ruled — ACME-12** The reader opens the wiki.",
      "",
      "| Claim | Detail |",
      "| --- | --- |",
      "| Open | Who edits pages |",
      "",
      "**Design choice** Pages are read-only.",
    ].join("\n"),
    claims: [],
  };
}

function render(
  subPath: string,
  options: { projectId?: string | null; list?: unknown } = {},
) {
  return renderSlot(
    registration,
    { subPath },
    {
      context: { projectId: options.projectId ?? null },
      rpc: {
        projects: () => projects,
        list: () => options.list ?? readyList(),
        page: (input: unknown) => {
          const pageId = (input as { pageId: string }).pageId;
          return pageId === "cuj-first"
            ? { state: "found", page: page() }
            : { state: "missing" };
        },
      },
    },
  );
}

describe("parseWikiLocation", () => {
  it("decodes the project and page segments", () => {
    expect(parseWikiLocation("proj%20a/cuj-first")).toEqual({
      projectId: "proj a",
      pageId: "cuj-first",
    });
  });

  it("returns nulls for an empty or malformed sub path", () => {
    expect(parseWikiLocation("")).toEqual({ projectId: null, pageId: null });
    expect(parseWikiLocation("%E0%A4%A/x")).toEqual({
      projectId: null,
      pageId: "x",
    });
  });
});

describe("Design Wiki nav panel", () => {
  it("registers a project-level Wiki page", () => {
    expect(registration.path).toBe("wiki");
    expect(registration.title).toBe("Design Wiki");
  });

  it("asks for a project when none is selected", async () => {
    const slot = render("");
    await slot.findByText("Select a project to read its design wiki.");
    await waitFor(() => slot.getByRole("option", { name: "Alpha" }));
  });

  it("uses the current project when the path names none", async () => {
    const slot = render("", { projectId: "proj_a" });
    await slot.findByRole("region", { name: "Critical user journeys" });
    expect(slot.rpcCalls.some((call) => call.method === "list")).toBe(true);
  });

  it("groups pages by kind with id, title, status, updated and card", async () => {
    const slot = render("proj_a");
    const cujs = await slot.findByRole("region", {
      name: "Critical user journeys",
    });
    const requirements = slot.getByRole("region", { name: "Requirements" });
    expect(within(cujs).getAllByRole("button")).toHaveLength(2);
    const row = cujs.querySelector('[data-wiki-row="cuj-first"]')!;
    expect(row.textContent).toContain("cuj-first");
    expect(row.textContent).toContain("First journey");
    expect(row.textContent).toContain("Ruled");
    expect(row.textContent).toContain("2026-10-30");
    expect(row.querySelector("[data-wiki-card]")?.textContent).toBe("ACME-12");
    expect(
      requirements.querySelector('[data-wiki-row="req-first"]'),
    ).not.toBeNull();
  });

  it("shows a malformed page as an error row without crashing", async () => {
    const slot = render("proj_a");
    await slot.findByRole("region", { name: "Requirements" });
    const error = slot.container.querySelector(
      '[data-wiki-error="docs/wiki/src/requirements/broken.md"]',
    )!;
    expect(error.textContent).toContain("Missing front matter field: status");
  });

  it("filters rows with the status chips", async () => {
    const slot = render("proj_a");
    await slot.findByRole("region", { name: "Critical user journeys" });
    fireEvent.click(slot.getByRole("button", { name: /^Open/ }));
    expect(slot.container.querySelector('[data-wiki-row="cuj-second"]')).not
      .toBeNull();
    expect(
      slot.container.querySelector('[data-wiki-row="cuj-first"]'),
    ).toBeNull();
    expect(
      slot.getByRole("button", { name: /^Open/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("explains an empty wiki", async () => {
    const slot = render("proj_a", {
      list: {
        state: "empty",
        message: "This project has no docs/wiki/src directory yet.",
        pages: [],
        errors: [],
      },
    });
    await slot.findByText("This project has no docs/wiki/src directory yet.");
  });

  it("navigates to a page when a row is selected", async () => {
    const slot = render("proj_a");
    await slot.findByRole("region", { name: "Critical user journeys" });
    fireEvent.click(slot.getByRole("button", { name: "Second journey" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "wiki",
      options: { subPath: "proj_a/cuj-second" },
    });
  });

  it("renders the page with claim styling and card references", async () => {
    const slot = render("proj_a/cuj-first");
    const article = await waitFor(() => {
      const node = slot.container.querySelector('[data-wiki-page="cuj-first"]');
      expect(node).not.toBeNull();
      return node!;
    });
    const claims = Array.from(article.querySelectorAll("[data-wiki-claim]"));
    expect(claims.map((node) => node.getAttribute("data-wiki-claim"))).toEqual([
      "ruled",
      "open",
      "design-choice",
    ]);
    const cards = Array.from(article.querySelectorAll("[data-wiki-card]"));
    expect(cards.map((node) => node.textContent)).toContain("ACME-12");
    expect(
      article.querySelector("[data-wiki-card]")?.getAttribute("href"),
    ).toBe("/plugins/tasks/tasks/task/ACME-12");
  });

  it("says when the selected page no longer exists", async () => {
    const slot = render("proj_a/cuj-gone");
    await slot.findByText("That page no longer exists.");
  });
});
