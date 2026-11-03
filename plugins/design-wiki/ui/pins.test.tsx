// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type { Pin } from "../contract.js";
import { PinnedPage } from "./pinned-page.js";
import { extractClaimMarkers } from "../claims.js";
import { claimTargetAt, resolvePinAnchor } from "../pin-anchor.js";
import {
  YAOIVERS_CAMPUS_BODY,
  YAOIVERS_RUN_BODY,
} from "../yaoivers-fixtures.js";
import type { WikiPage, WikiPageSummary } from "../wiki-types.js";

const app = await loadPluginApp(() => import("../app.js"));
const navPanel = app.navPanels[0]!;
const tab = app.tabs.find((candidate) => candidate.id === "wiki")!;
afterEach(cleanup);

const PAGE_ID = "req-campus";
const PATH = "docs/wiki/src/requirements/campus.md";

function pageOf(body: string, id = PAGE_ID): WikiPage {
  return {
    id,
    kind: "requirement",
    path: PATH,
    title: "Calendar and campus",
    status: "ruled",
    card: null,
    source: "test",
    updated: "2026-11-02",
    body,
    claims: extractClaimMarkers(body),
  };
}

function summaryOf(page: WikiPage): WikiPageSummary {
  const { body: _body, claims: _claims, ...summary } = page;
  return summary;
}

function pinFor(
  page: WikiPage,
  claimIndex: number | null,
  overrides: Partial<Pin> = {},
): Pin {
  const claim = claimIndex === null ? null : claimTargetAt(page, claimIndex);
  return {
    id: `pin_${claimIndex ?? "page"}`,
    projectId: "proj_a",
    pageId: page.id,
    sourcePath: page.path,
    claim,
    body: "A note",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    resolvedAt: null,
    threadIds: [],
    anchor: resolvePinAnchor(
      { pageId: page.id, sourcePath: page.path, claim },
      {
        pages: [page],
        list: {
          state: "ready",
          message: null,
          pages: [summaryOf(page)],
          errors: [],
        },
      },
    ),
    ...overrides,
  };
}

interface Mounted {
  slot: ReturnType<typeof renderSlot>;
  store: Pin[];
  calls: { method: string; input: unknown }[];
  page: WikiPage;
  mode: "panel" | "tab";
}

function mount(
  options: {
    body?: string;
    pins?: (page: WikiPage) => Pin[];
    pages?: WikiPage[];
    mode?: "panel" | "tab";
    createResult?: unknown;
    pinsFail?: boolean;
  } = {},
): Mounted {
  const page = pageOf(options.body ?? YAOIVERS_CAMPUS_BODY);
  const pages = options.pages ?? [page];
  const store = options.pins?.(page) ?? [];
  const calls: Mounted["calls"] = [];
  const list = {
    state: pages.length === 0 ? "empty" : "ready",
    message: null,
    pages: pages.map(summaryOf),
    errors: [],
  };
  const record = (method: string, input: unknown) =>
    calls.push({ method, input });
  const rpc = {
    projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
    list: () => list,
    page: (input: unknown) => {
      const found = pages.find(
        (candidate) => candidate.id === (input as { pageId: string }).pageId,
      );
      return found ? { state: "found", page: found } : { state: "missing" };
    },
    pins: () => {
      if (options.pinsFail) throw new Error("pins unavailable");
      return store;
    },
    createPin: (input: unknown) => {
      record("createPin", input);
      if (options.createResult !== undefined) return options.createResult;
      const typed = input as {
        pageId: string;
        claim: Pin["claim"];
        body: string;
      };
      const created = pinFor(page, null, {
        id: `pin_new_${store.length}`,
        pageId: typed.pageId,
        claim: typed.claim,
        body: typed.body,
      });
      store.push(created);
      return { ok: true, pin: created };
    },
    updatePin: (input: unknown) => {
      record("updatePin", input);
      const typed = input as {
        pinId: string;
        body?: string;
        resolved?: boolean;
      };
      const index = store.findIndex((pin) => pin.id === typed.pinId);
      const current = store[index]!;
      const next: Pin = {
        ...current,
        body: typed.body ?? current.body,
        resolvedAt:
          typed.resolved === undefined
            ? current.resolvedAt
            : typed.resolved
              ? "2026-11-03T01:00:00.000Z"
              : null,
      };
      store[index] = next;
      return { ok: true, pin: next };
    },
    deletePin: (input: unknown) => {
      record("deletePin", input);
      const typed = input as { pinId: string };
      const index = store.findIndex((pin) => pin.id === typed.pinId);
      if (index >= 0) store.splice(index, 1);
      return { deleted: index >= 0 };
    },
    linkPinThread: (input: unknown) => {
      record("linkPinThread", input);
      const typed = input as { pinId: string; threadId: string };
      const index = store.findIndex((pin) => pin.id === typed.pinId);
      const current = store[index]!;
      const next: Pin = {
        ...current,
        threadIds: current.threadIds.includes(typed.threadId)
          ? current.threadIds
          : [...current.threadIds, typed.threadId],
      };
      store[index] = next;
      return { ok: true, pin: next };
    },
  };
  const slot =
    options.mode === "tab"
      ? renderSlot(
          tab as never,
          { threadId: "thr_1", environment: null } as never,
          {
            context: { projectId: "proj_a", threadId: "thr_1" },
            rpc,
          },
        )
      : renderSlot(
          navPanel,
          { subPath: `proj_a/${page.id}` },
          { context: { projectId: null }, rpc },
        );
  return { slot, store, calls, page, mode: options.mode ?? "panel" };
}

async function openPage(mounted: Mounted) {
  if (
    mounted.mode === "tab" &&
    !mounted.slot.container.querySelector("[data-wiki-page]")
  ) {
    const row = await mounted.slot.findByRole("button", {
      name: new RegExp(mounted.page.title),
    });
    fireEvent.click(row);
  }
  return waitFor(() => {
    const node = mounted.slot.container.querySelector("[data-wiki-page]");
    expect(node).not.toBeNull();
    return node as HTMLElement;
  });
}

function controls(article: HTMLElement): HTMLElement[] {
  return Array.from(
    article.querySelectorAll<HTMLElement>("[data-pin-claim-index]"),
  );
}

function menuIndexes(article: HTMLElement): number[] {
  return Array.from(
    article.querySelectorAll<HTMLElement>("[data-pin-menu-claim-index]"),
  ).map((node) => Number(node.dataset.pinMenuClaimIndex));
}

function allIndexes(article: HTMLElement): number[] {
  return [
    ...controls(article).map((node) => Number(node.dataset.pinClaimIndex)),
    ...menuIndexes(article),
  ].sort((a, b) => a - b);
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe("claim controls on real wiki content", () => {
  it("gives every parsed claim of the campus requirement exactly one control", async () => {
    const mounted = mount();
    const article = await openPage(mounted);
    expect(mounted.page.claims.length).toBe(10);
    expect(allIndexes(article)).toEqual(range(10));
    expect(menuIndexes(article)).toEqual([]);
  });

  it("puts the control for a table-cell claim inside that cell", async () => {
    const mounted = mount();
    const article = await openPage(mounted);
    const cell = Array.from(article.querySelectorAll("td")).find((node) =>
      node.textContent?.startsWith("Ruled — YAOI-145"),
    )!;
    expect(
      within(cell).getAllByRole("button", { name: /^Pin claim:/ }),
    ).toHaveLength(1);
  });

  it("gives every parsed claim of the run journey exactly one control", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    expect(mounted.page.claims.length).toBe(3);
    expect(allIndexes(article)).toEqual(range(3));
  });

  it("labels each control with its claim", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    const first = controls(article)[0]!;
    expect(first.getAttribute("aria-label")).toBe(
      `Pin claim: ${mounted.page.claims[0]!.label}`,
    );
  });
});

describe("claim controls on synthetic content", () => {
  it("handles two byte-identical bold claims on one line as two targets", async () => {
    const mounted = mount({ body: "**Open: x** and **Open: x**\n" });
    const article = await openPage(mounted);
    expect(controls(article).map((node) => node.dataset.pinClaimIndex)).toEqual(
      ["0", "1"],
    );
  });

  it("handles repeated labels on different lines", async () => {
    const mounted = mount({ body: "**Open: x**\n\n**Open: x**\n" });
    const article = await openPage(mounted);
    expect(allIndexes(article)).toEqual([0, 1]);
  });

  it("finds a claim in a list item", async () => {
    const mounted = mount({ body: "- **Open: in a list**\n- plain\n" });
    const article = await openPage(mounted);
    expect(allIndexes(article)).toEqual([0]);
    expect(menuIndexes(article)).toEqual([]);
  });

  it("owns a plain cell claim with emphasis inside the cell", async () => {
    const mounted = mount({
      body: "| S | T |\n|---|---|\n| Open: *question* | x |\n| Open: **detail** | y |\n",
    });
    const article = await openPage(mounted);
    expect(controls(article)).toHaveLength(2);
    expect(menuIndexes(article)).toEqual([]);
  });

  it("lets a bold claim at the start of a cell own the cell's control", async () => {
    const mounted = mount({
      body: "| S | T |\n|---|---|\n| **Open: A** | x |\n",
    });
    const article = await openPage(mounted);
    expect(controls(article)).toHaveLength(1);
    expect(allIndexes(article)).toEqual([0]);
  });

  it("puts a claim it cannot place in the fallback menu while neighbours keep controls", async () => {
    const mounted = mount({
      body: "**Open: first**\n\n**Open — [linked](https://example.com):**\n\n**Open: third**\n",
    });
    const article = await openPage(mounted);
    expect(mounted.page.claims).toHaveLength(3);
    expect(controls(article).map((node) => node.dataset.pinClaimIndex)).toEqual(
      ["0", "2"],
    );
    expect(menuIndexes(article)).toEqual([1]);
    expect(allIndexes(article)).toEqual([0, 1, 2]);
    const summary = article.querySelector("details summary");
    expect(summary?.textContent).toBe("Claims without an inline control (1)");
  });

  it("gives no control to a claim inside a fenced block", async () => {
    const mounted = mount({
      body: "```\n**Open: fenced**\n```\n\n**Open: real**\n",
    });
    const article = await openPage(mounted);
    expect(mounted.page.claims).toHaveLength(1);
    expect(allIndexes(article)).toEqual([0]);
  });

  it("shows no menu and no controls when the page has no claims", async () => {
    const mounted = mount({ body: "Just prose.\n" });
    const article = await openPage(mounted);
    expect(controls(article)).toEqual([]);
    expect(article.querySelector("details")).toBeNull();
  });
});

describe("pin composer", () => {
  it("keeps a page note", async () => {
    const mounted = mount();
    const article = await openPage(mounted);
    fireEvent.click(
      within(article).getByRole("button", { name: "Pin this page" }),
    );
    const note = within(article).getByLabelText("Pin note");
    fireEvent.change(note, { target: { value: "Check the semester length" } });
    fireEvent.click(
      within(article).getByRole("button", { name: "Keep as note" }),
    );
    await waitFor(() => expect(mounted.calls).toHaveLength(1));
    expect(mounted.calls[0]).toEqual({
      method: "createPin",
      input: {
        projectId: "proj_a",
        pageId: PAGE_ID,
        claim: null,
        body: "Check the semester length",
      },
    });
    mounted.slot.experimental_invalidateRpc(["design-wiki:pins:proj_a"]);
    await within(article).findByText("Check the semester length");
  });

  it("keeps a note on a claim with the claim's identity", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    fireEvent.click(controls(article)[2]!);
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "Needs a ruling" },
    });
    fireEvent.click(
      within(article).getByRole("button", { name: "Keep as note" }),
    );
    await waitFor(() => expect(mounted.calls).toHaveLength(1));
    expect(mounted.calls[0]!.input).toEqual({
      projectId: "proj_a",
      pageId: PAGE_ID,
      claim: claimTargetAt(mounted.page, 2),
      body: "Needs a ruling",
    });
  });

  it("will not save an empty note", async () => {
    const mounted = mount();
    const article = await openPage(mounted);
    fireEvent.click(
      within(article).getByRole("button", { name: "Pin this page" }),
    );
    const keep = within(article).getByRole("button", { name: "Keep as note" });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a stale claim instead of failing silently", async () => {
    const mounted = mount({
      body: YAOIVERS_RUN_BODY,
      createResult: { ok: false, reason: "stale-claim" },
    });
    const article = await openPage(mounted);
    fireEvent.click(controls(article)[0]!);
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "x" },
    });
    fireEvent.click(
      within(article).getByRole("button", { name: "Keep as note" }),
    );
    await within(article).findByText(
      "That claim changed on the page. Reopen the page and pin it again.",
    );
  });

  it("opens the composer for the clicked claim and closes it on cancel", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    fireEvent.click(controls(article)[1]!);
    expect(within(article).getByLabelText("Pin note")).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Cancel" }));
    expect(within(article).queryByLabelText("Pin note")).toBeNull();
  });
});

describe("pin composer target", () => {
  function harness(initial: WikiPage) {
    const calls: { method: string; input: unknown }[] = [];
    const handle: { swap: (page: WikiPage) => void } = { swap: () => {} };
    function Harness() {
      const [page, setPage] = useState(initial);
      useEffect(() => {
        handle.swap = setPage;
      }, []);
      return <PinnedPage projectId="proj_a" page={page} threadId={null} />;
    }
    const slot = renderSlot(
      { component: Harness },
      {},
      {
        context: { projectId: "proj_a" },
        rpc: {
          pins: () => [],
          createPin: (input: unknown) => {
            calls.push({ method: "createPin", input });
            return {
              ok: true,
              pin: pinFor(initial, null, {
                claim: (input as { claim: Pin["claim"] }).claim,
              }),
            };
          },
        },
      },
    );
    return { slot, calls, swap: (page: WikiPage) => act(() => handle.swap(page)) };
  }

  it("keeps submitting the claim that was clicked when claims shift under the composer", async () => {
    const original = pageOf(YAOIVERS_RUN_BODY, "cuj-run");
    const shifted = pageOf(
      `**Ruled:** a brand new claim.\n\n${YAOIVERS_RUN_BODY}`,
      "cuj-run",
    );
    const mounted = harness(original);
    const article = await mounted.slot.findByRole("article");
    fireEvent.click(controls(article)[1]!);
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "On the second claim" },
    });
    mounted.swap(shifted);
    fireEvent.click(
      within(article).getByRole("button", { name: "Keep as note" }),
    );
    await waitFor(() => expect(mounted.calls).toHaveLength(1));
    expect(mounted.calls[0]!.input).toEqual({
      projectId: "proj_a",
      pageId: "cuj-run",
      claim: claimTargetAt(original, 1),
      body: "On the second claim",
    });
  });

  it("closes the composer when its claim no longer exists on the page", async () => {
    const original = pageOf(YAOIVERS_RUN_BODY, "cuj-run");
    const edited = pageOf(
      YAOIVERS_RUN_BODY.replace("Open", "Reopened"),
      "cuj-run",
    );
    const mounted = harness(original);
    const article = await mounted.slot.findByRole("article");
    const lastClaim = controls(article).length - 1;
    fireEvent.click(controls(article)[lastClaim]!);
    expect(within(article).getByLabelText("Pin note")).toBeTruthy();
    mounted.swap(edited);
    expect(mounted.slot.queryByLabelText("Pin note")).toBeNull();
  });

  it("closes the composer when the page changes", async () => {
    const first = pageOf(YAOIVERS_RUN_BODY, "cuj-run");
    const second = pageOf(YAOIVERS_CAMPUS_BODY, "req-campus");
    const mounted = harness(first);
    const article = await mounted.slot.findByRole("article");
    fireEvent.click(controls(article)[0]!);
    expect(within(article).getByLabelText("Pin note")).toBeTruthy();
    mounted.swap(second);
    expect(mounted.slot.queryByLabelText("Pin note")).toBeNull();
  });
});

describe("pin list", () => {
  it("shows persisted pins with their anchor state and a count on the claim", async () => {
    const mounted = mount({
      body: YAOIVERS_RUN_BODY,
      pins: (page) => [pinFor(page, 1, { body: "Why ten games?" })],
    });
    const article = await openPage(mounted);
    const item = await within(article).findByText("Why ten games?");
    const row = item.closest("li")!;
    expect(row.textContent).toContain("Claim, line");
    expect(controls(article)[1]!.textContent).toContain("1");
  });

  it("marks a pin whose claim changed as detached", async () => {
    const mounted = mount({
      body: "**Open: q** edited\n",
      pins: () => [
        pinFor(pageOf("**Open: q** original\n"), 0, { body: "Old note" }),
      ],
    });
    const article = await openPage(mounted);
    const row = (await within(article).findByText("Old note")).closest("li")!;
    expect(row.textContent).toContain("Detached");
  });

  it("resolves, reopens and deletes a pin", async () => {
    const mounted = mount({
      body: YAOIVERS_RUN_BODY,
      pins: (page) => [pinFor(page, null, { body: "Page note" })],
    });
    const article = await openPage(mounted);
    const row = (await within(article).findByText("Page note")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(mounted.calls.at(-1)).toEqual({
        method: "updatePin",
        input: { projectId: "proj_a", pinId: "pin_page", resolved: true },
      }),
    );
    mounted.slot.experimental_invalidateRpc(["design-wiki:pins:proj_a"]);
    const resolvedRow = (await within(article).findByText("Page note")).closest(
      "li",
    )!;
    await within(resolvedRow).findByRole("button", { name: "Reopen" });
    fireEvent.click(
      within(resolvedRow).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(mounted.calls.at(-1)).toEqual({
        method: "deletePin",
        input: { projectId: "proj_a", pinId: "pin_page" },
      }),
    );
  });

  it("edits a note", async () => {
    const mounted = mount({
      body: YAOIVERS_RUN_BODY,
      pins: (page) => [pinFor(page, null, { body: "Page note" })],
    });
    const article = await openPage(mounted);
    const row = (await within(article).findByText("Page note")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row).getByLabelText("Pin note"), {
      target: { value: "Changed" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mounted.calls.at(-1)).toEqual({
        method: "updatePin",
        input: { projectId: "proj_a", pinId: "pin_page", body: "Changed" },
      }),
    );
  });

  it("still renders the page when the pins query fails", async () => {
    const mounted = mount({ pinsFail: true });
    const article = await openPage(mounted);
    expect(controls(article).length).toBeGreaterThan(0);
  });
});

describe("Discuss now", () => {
  it("in the thread tab saves the pin, links this thread and marks it discussed here", async () => {
    const mounted = mount({ mode: "tab", body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    fireEvent.click(controls(article)[0]!);
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "Talk about this" },
    });
    fireEvent.click(
      within(article).getByRole("button", { name: "Discuss now" }),
    );
    await waitFor(() =>
      expect(mounted.calls.map((call) => call.method)).toEqual([
        "createPin",
        "linkPinThread",
      ]),
    );
    expect(mounted.calls[1]!.input).toMatchObject({
      projectId: "proj_a",
      threadId: "thr_1",
    });
    mounted.slot.experimental_invalidateRpc(["design-wiki:pins:proj_a"]);
    const row = (await within(article).findByText("Talk about this")).closest(
      "li",
    )!;
    expect(row.textContent).toContain("Discussed in this thread");
  });

  it("in the thread tab lists linked threads and opens one", async () => {
    const mounted = mount({
      mode: "tab",
      body: YAOIVERS_RUN_BODY,
      pins: (page) => [
        pinFor(page, null, { body: "Linked note", threadIds: ["thr_9"] }),
      ],
    });
    const article = await openPage(mounted);
    const row = (await within(article).findByText("Linked note")).closest(
      "li",
    )!;
    fireEvent.click(within(row).getByRole("button", { name: /thr_9/ }));
    expect(mounted.slot.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_9" },
    ]);
  });

  it("on the project page opens a draft naming the page, the claim and the note", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    fireEvent.click(controls(article)[2]!);
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "Decide the recruitment outcome" },
    });
    fireEvent.click(
      within(article).getByRole("button", { name: "Discuss now" }),
    );
    await waitFor(() => expect(mounted.slot.navigateCalls).toHaveLength(1));
    const call = mounted.slot.navigateCalls[0] as {
      method: string;
      options: { projectId?: string; initialPrompt?: string };
    };
    expect(call.method).toBe("toCompose");
    expect(call.options.projectId).toBe("proj_a");
    expect(call.options.initialPrompt).toContain(PAGE_ID);
    expect(call.options.initialPrompt).toContain(mounted.page.claims[2]!.label);
    expect(call.options.initialPrompt).toContain(
      "Decide the recruitment outcome",
    );
    expect(mounted.calls.map((entry) => entry.method)).toEqual(["createPin"]);
    await within(article).findByText(/Discussion draft opened/);
  });
});

describe("detached pins whose page is gone", () => {
  it("lists them at project level with the gone page named", async () => {
    const gone = pageOf("**Open: q**\n", "req-gone");
    const mounted = mount({
      pages: [pageOf(YAOIVERS_RUN_BODY, "cuj-run")],
      mode: "tab",
      pins: () => [
        pinFor(gone, 0, {
          body: "Orphan note",
          pageId: "req-gone",
          anchor: { state: "detached", reason: "page-missing" },
        }),
      ],
    });
    const region = await mounted.slot.findByRole("region", {
      name: "Detached pins",
    });
    expect(within(region).getByText("Orphan note")).toBeTruthy();
    expect(region.textContent).toContain("req-gone");
  });

  it("shows no detached section when every pin has its page", async () => {
    const mounted = mount({
      mode: "tab",
      pins: (page) => [pinFor(page, null)],
    });
    await mounted.slot.findByRole("button", { name: /Calendar and campus/ });
    expect(
      mounted.slot.queryByRole("region", { name: "Detached pins" }),
    ).toBeNull();
  });
});

describe("freshness", () => {
  it("shows a pin created in one view in another mounted view after invalidation", async () => {
    const mounted = mount({ body: YAOIVERS_RUN_BODY });
    const article = await openPage(mounted);
    const second = renderSlot(
      navPanel,
      { subPath: `proj_a/${PAGE_ID}` },
      {
        context: { projectId: null },
        rpc: {
          projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
          list: () => ({
            state: "ready",
            message: null,
            pages: [summaryOf(mounted.page)],
            errors: [],
          }),
          page: () => ({ state: "found", page: mounted.page }),
          pins: () => mounted.store,
        },
      },
    );
    await waitFor(() =>
      expect(second.container.querySelector("[data-wiki-page]")).not.toBeNull(),
    );
    fireEvent.click(
      within(article).getByRole("button", { name: "Pin this page" }),
    );
    fireEvent.change(within(article).getByLabelText("Pin note"), {
      target: { value: "Shared note" },
    });
    fireEvent.click(
      within(article).getByRole("button", { name: "Keep as note" }),
    );
    await waitFor(() => expect(mounted.store).toHaveLength(1));
    mounted.slot.experimental_invalidateRpc(["design-wiki:pins:proj_a"]);
    second.experimental_invalidateRpc(["design-wiki:pins:proj_a"]);
    await second.findByText("Shared note");
  });
});
