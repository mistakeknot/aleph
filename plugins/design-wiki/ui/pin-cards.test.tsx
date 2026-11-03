// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractClaimMarkers } from "../claims.js";
import type { PinTaskItem, Pin } from "../contract.js";
import { claimTargetAt, resolvePinAnchor } from "../pin-anchor.js";
import { YAOIVERS_RUN_BODY } from "../yaoivers-fixtures.js";
import type { WikiPage, WikiPageSummary } from "../wiki-types.js";
import { PIN_TASKS_REFRESH_MS } from "./pin-cards.js";

const opened = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("./open-card.js", () => ({
  openCard: (key: string) => {
    opened.keys.push(key);
  },
}));

const app = await loadPluginApp(() => import("../app.js"));
const navPanel = app.navPanels[0]!;

beforeEach(() => {
  opened.keys.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PAGE_ID = "cuj-run";
const PATH = "docs/wiki/src/cujs/run.md";

function pageOf(): WikiPage {
  return {
    id: PAGE_ID,
    kind: "cuj",
    path: PATH,
    title: "A run",
    status: "ruled",
    card: null,
    source: "test",
    updated: "2026-11-02",
    body: YAOIVERS_RUN_BODY,
    claims: extractClaimMarkers(YAOIVERS_RUN_BODY),
  };
}

function summaryOf(page: WikiPage): WikiPageSummary {
  const { body: _body, claims: _claims, ...summary } = page;
  return summary;
}

function pinOf(page: WikiPage, id = "pin_1"): Pin {
  const claim = claimTargetAt(page, 0);
  return {
    id,
    projectId: "proj_a",
    pageId: page.id,
    sourcePath: page.path,
    claim,
    body: "Decide the first question",
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
  };
}

function itemOf(overrides: Partial<PinTaskItem> = {}): PinTaskItem {
  return {
    pinId: "pin_1",
    taskId: "T1",
    key: "ACME-7",
    state: "found",
    message: null,
    title: "Decide the first question",
    status: "in_progress",
    threads: [],
    pullRequests: [],
    unavailableThreadIds: [],
    ...overrides,
  };
}

interface Options {
  items?: PinTaskItem[];
  createResult?: unknown;
  linkResult?: unknown;
  pinTasksFail?: boolean;
}

function mount(options: Options = {}) {
  const page = pageOf();
  const items = options.items ?? [];
  const calls: { method: string; input: unknown }[] = [];
  const pinTasksCalls = { count: 0 };
  const record = (method: string, input: unknown) =>
    calls.push({ method, input });
  const rpc = {
    projects: () => [{ id: "proj_a", name: "Alpha", hasCheckout: true }],
    list: () => ({
      state: "ready",
      message: null,
      pages: [summaryOf(page)],
      errors: [],
    }),
    page: () => ({ state: "found", page }),
    pins: () => [pinOf(page)],
    pinTasks: () => {
      pinTasksCalls.count += 1;
      if (options.pinTasksFail) throw new Error("tasks unavailable");
      return items;
    },
    createPinTask: (input: unknown) => {
      record("createPinTask", input);
      if (options.createResult !== undefined) return options.createResult;
      items.push(itemOf());
      return { ok: true, task: { id: "T1", key: "ACME-7" } };
    },
    linkPinTask: (input: unknown) => {
      record("linkPinTask", input);
      if (options.linkResult !== undefined) return options.linkResult;
      items.push(itemOf({ taskId: "T9", key: "ACME-9" }));
      return { ok: true, task: { id: "T9", key: "ACME-9" } };
    },
    unlinkPinTask: (input: unknown) => {
      record("unlinkPinTask", input);
      items.splice(0, items.length);
      return { removed: true };
    },
  };
  const slot = renderSlot(
    navPanel,
    { subPath: `proj_a/${page.id}` },
    { context: { projectId: null }, rpc },
  );
  return { slot, calls, items, pinTasksCalls };
}

async function pinRow(slot: ReturnType<typeof renderSlot>) {
  const row = await waitFor(() => {
    const node = slot.container.querySelector<HTMLElement>("[data-pin-id]");
    expect(node).not.toBeNull();
    return node!;
  });
  return row;
}

describe("make task", () => {
  it("creates a card from the pin and shows its key", async () => {
    const { slot, calls } = mount();
    const row = await pinRow(slot);
    fireEvent.click(within(row).getByRole("button", { name: "Make task" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "createPinTask",
        input: { projectId: "proj_a", pinId: "pin_1" },
      }),
    );
    await within(row).findByRole("button", { name: "Open ACME-7" });
  });

  it("opens the card in the tasks panel", async () => {
    const { slot } = mount({ items: [itemOf()] });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", { name: "Open ACME-7" }),
    );
    expect(opened.keys).toEqual(["ACME-7"]);
  });

  it("explains when no board is linked to the project", async () => {
    const { slot } = mount({
      createResult: {
        ok: false,
        reason: "no-board",
        message: "No task board is linked to this project.",
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(within(row).getByRole("button", { name: "Make task" }));
    await within(row).findByText("No task board is linked to this project.");
  });

  it("asks which board when several are linked and retries with the choice", async () => {
    const { slot, calls } = mount({
      createResult: {
        ok: false,
        reason: "board-required",
        message: "Several boards are linked. Pick one.",
        boards: [
          { id: "B1", name: "Alpha", prefix: "ALPH" },
          { id: "B2", name: "Beta", prefix: "BETA" },
        ],
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(within(row).getByRole("button", { name: "Make task" }));
    await within(row).findByText("Several boards are linked. Pick one.");
    fireEvent.click(
      within(row).getByRole("button", { name: "Make task on Beta (BETA)" }),
    );
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "createPinTask",
        input: { projectId: "proj_a", pinId: "pin_1", taskProjectId: "B2" },
      }),
    );
  });

  it("offers to link the created card when recording it failed", async () => {
    const { slot, calls } = mount({
      createResult: {
        ok: false,
        reason: "not-linked",
        message: "The card ACME-7 was created but not recorded on the pin.",
        task: { id: "T1", key: "ACME-7" },
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(within(row).getByRole("button", { name: "Make task" }));
    await within(row).findByText(
      "The card ACME-7 was created but not recorded on the pin.",
    );
    const input = within(row).getByLabelText("Card key") as HTMLInputElement;
    expect(input.value).toBe("ACME-7");
    fireEvent.click(within(row).getByRole("button", { name: "Link card" }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "linkPinTask",
        input: { projectId: "proj_a", pinId: "pin_1", taskKey: "ACME-7" },
      }),
    );
  });

  it("shows a refusal from the tasks plugin and keeps the pin usable", async () => {
    const { slot } = mount({
      createResult: {
        ok: false,
        reason: "tasks-refused",
        message: "The task board refused the card: title too long.",
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(within(row).getByRole("button", { name: "Make task" }));
    await within(row).findByText(
      "The task board refused the card: title too long.",
    );
    expect(
      (within(row).getByRole("button", { name: "Make task" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("link existing card", () => {
  it("links a card by key from a field revealed on demand", async () => {
    const { slot, calls } = mount();
    const row = await pinRow(slot);
    expect(within(row).queryByLabelText("Card key")).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Link existing card" }),
    );
    fireEvent.change(within(row).getByLabelText("Card key"), {
      target: { value: " ACME-9 " },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Link card" }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "linkPinTask",
        input: { projectId: "proj_a", pinId: "pin_1", taskKey: "ACME-9" },
      }),
    );
    await within(row).findByRole("button", { name: "Open ACME-9" });
    expect(within(row).queryByLabelText("Card key")).toBeNull();
  });

  it("will not submit an empty key", async () => {
    const { slot } = mount();
    const row = await pinRow(slot);
    fireEvent.click(
      within(row).getByRole("button", { name: "Link existing card" }),
    );
    expect(
      (within(row).getByRole("button", { name: "Link card" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("explains a card that is on another project's board", async () => {
    const { slot } = mount({
      linkResult: {
        ok: false,
        reason: "wrong-board",
        message: "That card is on a board not linked to this project.",
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(
      within(row).getByRole("button", { name: "Link existing card" }),
    );
    fireEvent.change(within(row).getByLabelText("Card key"), {
      target: { value: "OTHER-1" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Link card" }));
    await within(row).findByText(
      "That card is on a board not linked to this project.",
    );
  });
});

describe("card status on the pin", () => {
  it("shows status, threads, pull requests and merge state", async () => {
    const { slot } = mount({
      items: [
        itemOf({
          threads: [
            { threadId: "thr_a", title: "Build it", liveStatus: "working" },
          ],
          pullRequests: [
            {
              url: "https://example.test/pr/5",
              number: 5,
              title: "Do it",
              state: "merged",
            },
            {
              url: "https://example.test/pr/6",
              number: 6,
              title: "More",
              state: "open",
            },
          ],
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText("In progress");
    within(row).getByText("Build it");
    within(row).getByText("working");
    const merged = within(row).getByRole("link", { name: /#5/ });
    expect(merged.getAttribute("href")).toBe("https://example.test/pr/5");
    within(row).getByText("merged");
    within(row).getByText("open");
  });

  it("opens a card thread", async () => {
    const { slot } = mount({
      items: [
        itemOf({
          threads: [
            { threadId: "thr_a", title: "Build it", liveStatus: "idle" },
          ],
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText("Build it");
    expect(within(row).getByRole("button", { name: /Build it/ })).toBeTruthy();
  });

  it("says when threads are unavailable", async () => {
    const { slot } = mount({
      items: [itemOf({ unavailableThreadIds: ["thr_x", "thr_y"] })],
    });
    const row = await pinRow(slot);
    await within(row).findByText("2 threads are unavailable");
  });

  it("says when the card was removed and offers to unlink it", async () => {
    const { slot, calls } = mount({
      items: [
        itemOf({
          state: "removed",
          title: null,
          status: null,
          message: "This card no longer exists.",
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText("Card removed");
    within(row).getByText("This card no longer exists.");
    fireEvent.click(within(row).getByRole("button", { name: "Unlink ACME-7" }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "unlinkPinTask",
        input: { projectId: "proj_a", pinId: "pin_1", taskId: "T1" },
      }),
    );
    await waitFor(() =>
      expect(within(row).queryByText("Card removed")).toBeNull(),
    );
  });

  it("shows the message when the task board cannot be read", async () => {
    const { slot } = mount({
      items: [
        itemOf({
          state: "unavailable",
          title: null,
          status: null,
          message: "The task board could not be read right now.",
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText("The task board could not be read right now.");
    within(row).getByRole("button", { name: "Open ACME-7" });
  });

  it("lists several cards on one pin", async () => {
    const { slot } = mount({
      items: [
        itemOf(),
        itemOf({ taskId: "T2", key: "ACME-8", status: "done" }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByRole("button", { name: "Open ACME-7" });
    within(row).getByRole("button", { name: "Open ACME-8" });
    within(row).getByText("Done");
  });

  it("still shows the pin when the card read fails", async () => {
    const { slot } = mount({ pinTasksFail: true });
    const row = await pinRow(slot);
    within(row).getByText("Decide the first question");
    within(row).getByRole("button", { name: "Make task" });
  });
});

describe("freshness", () => {
  it("rereads card status on an interval while a pin holds a card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { slot, pinTasksCalls } = mount({ items: [itemOf()] });
    await pinRow(slot);
    await within(slot.container).findByRole("button", { name: "Open ACME-7" });
    const before = pinTasksCalls.count;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PIN_TASKS_REFRESH_MS + 50);
    });
    await waitFor(() => expect(pinTasksCalls.count).toBeGreaterThan(before));
  });

  it("does not poll when no pin holds a card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { slot, pinTasksCalls } = mount();
    await pinRow(slot);
    await waitFor(() => expect(pinTasksCalls.count).toBeGreaterThan(0));
    const before = pinTasksCalls.count;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PIN_TASKS_REFRESH_MS * 3);
    });
    expect(pinTasksCalls.count).toBe(before);
  });

  it("rereads card status when the window regains focus", async () => {
    const { slot, pinTasksCalls } = mount({ items: [itemOf()] });
    await pinRow(slot);
    await within(slot.container).findByRole("button", { name: "Open ACME-7" });
    const before = pinTasksCalls.count;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(pinTasksCalls.count).toBeGreaterThan(before));
  });

  it("shows a changed status after the tasks plugin invalidates the read", async () => {
    const { slot, items } = mount({ items: [itemOf()] });
    const row = await pinRow(slot);
    await within(row).findByText("In progress");
    items[0] = itemOf({ status: "done" });
    slot.experimental_invalidateRpc(["design-wiki:pin-tasks:proj_a"]);
    await within(row).findByText("Done");
  });
});
