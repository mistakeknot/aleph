// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WikiPage, WikiPageSummary } from "./wiki-types.js";

const store = vi.hoisted(() => {
  let projectId: string | null = "proj_a";
  const listeners = new Set<() => void>();
  return {
    get: () => projectId,
    set(next: string | null) {
      projectId = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useBbContext: () => ({
      ...actual.useBbContext(),
      projectId: useSyncExternalStore(store.subscribe, store.get),
    }),
  };
});

const app = await loadPluginApp(() => import("./app.js"));
const tab = app.tabs.find((candidate) => candidate.id === "wiki")!;
afterEach(() => {
  cleanup();
  store.set("proj_a");
});

const pages: WikiPageSummary[] = [
  {
    id: "cuj-first",
    kind: "cuj",
    path: "docs/wiki/src/cujs/first.md",
    title: "First journey",
    status: "ruled",
    card: null,
    source: "ruling",
    updated: "2026-10-30",
  },
];
const readyList = { state: "ready", message: null, pages, errors: [] };

const rpc = {
  projects: () => [
    { id: "proj_a", name: "Alpha", hasCheckout: true },
    { id: "proj_b", name: "Beta", hasCheckout: true },
  ],
  list: () => readyList,
  page: () => ({
    state: "found",
    page: {
      ...pages[0]!,
      body: "# First journey\n\n**Ruled** The reader opens the wiki.",
      claims: [],
    } satisfies WikiPage,
  }),
};

function mount() {
  return renderSlot(
    tab as never,
    { threadId: "thr_1", environment: null } as never,
    { context: { projectId: "proj_a", threadId: "thr_1" }, rpc },
  );
}

async function openFirstPage(slot: ReturnType<typeof mount>) {
  fireEvent.click(await slot.findByRole("button", { name: "First journey" }));
  await waitFor(() =>
    expect(
      slot.container.querySelector('[data-wiki-page="cuj-first"]'),
    ).not.toBeNull(),
  );
}

describe("Design Wiki thread panel when the thread's project changes", () => {
  it("drops the open page when the project changes", async () => {
    const slot = mount();
    await openFirstPage(slot);

    act(() => store.set("proj_b"));

    await slot.findByRole("region", { name: "Critical user journeys" });
    expect(slot.container.querySelector("[data-wiki-page]")).toBeNull();
    const lists = slot.rpcCalls.filter((call) => call.method === "list");
    expect(lists.map((call) => call.input)).toContainEqual({
      projectId: "proj_b",
    });
  });

  it("falls back to the no-project state and loses the open page", async () => {
    const slot = mount();
    await openFirstPage(slot);

    act(() => store.set(null));

    await slot.findByText(
      "This thread has no project, so it has no design wiki.",
    );
    expect(slot.container.querySelector("[data-wiki-page]")).toBeNull();
  });
});
