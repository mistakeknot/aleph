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
import type { Pin, PinDecisionItem } from "../contract.js";
import { claimTargetAt, resolvePinAnchor } from "../pin-anchor.js";
import { YAOIVERS_RUN_BODY } from "../yaoivers-fixtures.js";
import type { WikiPage, WikiPageSummary } from "../wiki-types.js";
import { PIN_DECISIONS_REFRESH_MS } from "./pin-decisions.js";

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

function decisionOf(overrides: Partial<PinDecisionItem> = {}): PinDecisionItem {
  return {
    pinId: "pin_1",
    key: "ACME-35",
    origin: "claim",
    state: "open",
    cardState: "open",
    title: "First question",
    answer: {
      decisionId: "dec-1",
      revision: "rev-1",
      question: "Which door first?",
      recommendation: "front",
      options: [
        { id: "front", label: "Front door" },
        { id: "back", label: "Back door" },
      ],
    },
    reason: null,
    ...overrides,
  };
}

interface Options {
  items?: PinDecisionItem[];
  answerResult?: unknown;
  answerThrows?: boolean;
  decisionsFail?: boolean;
}

function mount(options: Options = {}) {
  const page = pageOf();
  let items = options.items ?? [];
  const calls: { method: string; input: unknown }[] = [];
  const counts = { decisions: 0 };
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
    pinTasks: () => [],
    pinDecisions: () => {
      counts.decisions += 1;
      if (options.decisionsFail) throw new Error("citadel unavailable");
      return items;
    },
    answerPinDecision: (input: unknown) => {
      calls.push({ method: "answerPinDecision", input });
      if (options.answerThrows) throw new Error("rpc down");
      if (options.answerResult !== undefined) return options.answerResult;
      items = [
        decisionOf({ state: "closed", cardState: "done", answer: null }),
      ];
      return { ok: true };
    },
  };
  const slot = renderSlot(
    navPanel,
    { subPath: `proj_a/${page.id}` },
    { context: { projectId: null }, rpc },
  );
  return {
    slot,
    calls,
    counts,
    setItems: (next: PinDecisionItem[]) => (items = next),
  };
}

async function pinRow(slot: ReturnType<typeof renderSlot>) {
  return await waitFor(() => {
    const node = slot.container.querySelector<HTMLElement>("[data-pin-id]");
    expect(node).not.toBeNull();
    return node!;
  });
}

describe("decisions on a pin", () => {
  it("shows the card, its question, the recommendation and the options", async () => {
    const { slot } = mount({ items: [decisionOf()] });
    const row = await pinRow(slot);
    await within(row).findByText("Which door first?");
    within(row).getByText("First question");
    within(row).getByText(/Recommended: Front door/);
    within(row).getByRole("button", { name: "Answer ACME-35: Front door" });
    within(row).getByRole("button", { name: "Answer ACME-35: Back door" });
  });

  it("opens the card in the tasks panel", async () => {
    const { slot } = mount({ items: [decisionOf()] });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", { name: "Open ACME-35" }),
    );
    expect(opened.keys).toEqual(["ACME-35"]);
  });

  it("answers in place with the shown revision and a fresh pick id", async () => {
    const { slot, calls } = mount({ items: [decisionOf()] });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", {
        name: "Answer ACME-35: Back door",
      }),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    const input = calls[0]!.input as Record<string, string>;
    expect(input).toMatchObject({
      projectId: "proj_a",
      pinId: "pin_1",
      key: "ACME-35",
      optionId: "back",
      revision: "rev-1",
    });
    expect(input.pickId).toMatch(/^[0-9a-f-]{36}$/);
    await within(row).findByText(/Closed/);
    expect(within(row).queryByRole("button", { name: /^Answer / })).toBeNull();
  });

  it("uses a different pick id for each click", async () => {
    const { slot, calls } = mount({
      items: [decisionOf()],
      answerResult: { ok: false, reason: "refused", message: "Not taken." },
    });
    const row = await pinRow(slot);
    const button = await within(row).findByRole("button", {
      name: "Answer ACME-35: Front door",
    });
    fireEvent.click(button);
    await within(row).findByText("Not taken.");
    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(2));
    const ids = calls.map((call) => (call.input as { pickId: string }).pickId);
    expect(new Set(ids).size).toBe(2);
  });

  it("reports a stale decision, re-reads it, and does not retry", async () => {
    const { slot, calls, counts, setItems } = mount({
      items: [decisionOf()],
      answerResult: {
        ok: false,
        reason: "stale",
        message: "This decision changed while you were looking at it.",
      },
    });
    const row = await pinRow(slot);
    await within(row).findByText("Which door first?");
    const before = counts.decisions;
    setItems([
      decisionOf({
        answer: {
          decisionId: "dec-1",
          revision: "rev-2",
          question: "Which window first?",
          recommendation: null,
          options: [{ id: "up", label: "Upstairs" }],
        },
      }),
    ]);
    fireEvent.click(
      within(row).getByRole("button", { name: "Answer ACME-35: Front door" }),
    );
    await within(row).findByText(
      "This decision changed while you were looking at it.",
    );
    await within(row).findByText("Which window first?");
    expect(counts.decisions).toBeGreaterThan(before);
    expect(calls).toHaveLength(1);
  });

  it("shows a refusal message and keeps the options", async () => {
    const { slot } = mount({
      items: [decisionOf()],
      answerResult: {
        ok: false,
        reason: "refused",
        message: "Citadel did not take the answer: already ruled.",
      },
    });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", {
        name: "Answer ACME-35: Front door",
      }),
    );
    await within(row).findByText(
      "Citadel did not take the answer: already ruled.",
    );
    within(row).getByRole("button", { name: "Answer ACME-35: Back door" });
  });

  it("reports an answer call that throws", async () => {
    const { slot } = mount({ items: [decisionOf()], answerThrows: true });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", {
        name: "Answer ACME-35: Front door",
      }),
    );
    await within(row).findByText(/Could not confirm whether Citadel took/);
    expect(within(row).queryByText(/Nothing was answered/)).toBeNull();
  });

  it("holds further picks on the same revision after an unconfirmed answer", async () => {
    const { slot, calls, setItems } = mount({
      items: [decisionOf()],
      answerThrows: true,
    });
    const row = await pinRow(slot);
    fireEvent.click(
      await within(row).findByRole("button", {
        name: "Answer ACME-35: Front door",
      }),
    );
    await within(row).findByText(/Could not confirm whether Citadel took/);
    await waitFor(() =>
      expect(
        (
          within(row).getByRole("button", {
            name: "Answer ACME-35: Front door",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    within(row).getByRole("button", { name: "Open card ACME-35" });
    expect(calls).toHaveLength(1);
    setItems([
      decisionOf({
        answer: { ...decisionOf().answer!, revision: "rev-2" },
      }),
    ]);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(
        (
          within(row).getByRole("button", {
            name: "Answer ACME-35: Front door",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("shows a read-only card with its reason and an Open card button", async () => {
    const { slot } = mount({
      items: [
        decisionOf({
          answer: null,
          reason:
            "This decision cannot be answered with one pick here. Open the card to answer it.",
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText(/cannot be answered with one pick/);
    expect(within(row).queryByRole("button", { name: /^Answer / })).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Open card ACME-35" }),
    );
    expect(opened.keys).toEqual(["ACME-35"]);
  });

  it("shows a closed card without answer controls", async () => {
    const { slot } = mount({
      items: [decisionOf({ state: "closed", cardState: "done", answer: null })],
    });
    const row = await pinRow(slot);
    await within(row).findByText(/Closed/);
    expect(within(row).queryByRole("button", { name: /^Answer / })).toBeNull();
  });

  it("shows missing and unavailable cards with their reasons", async () => {
    const { slot } = mount({
      items: [
        decisionOf({
          key: "ACME-1",
          state: "missing",
          cardState: null,
          title: null,
          answer: null,
          reason: "Citadel has no card with this key.",
        }),
        decisionOf({
          key: "ACME-2",
          state: "unavailable",
          cardState: null,
          title: null,
          answer: null,
          reason: "Could not reach Citadel to read this card.",
        }),
      ],
    });
    const row = await pinRow(slot);
    await within(row).findByText("Citadel has no card with this key.");
    within(row).getByText("Could not reach Citadel to read this card.");
  });

  it("shows nothing when the pin has no decision cards", async () => {
    const { slot } = mount({ items: [] });
    const row = await pinRow(slot);
    expect(within(row).queryByRole("list", { name: "Decisions" })).toBeNull();
  });

  it("only shows decisions for its own pin", async () => {
    const { slot } = mount({
      items: [decisionOf({ pinId: "pin_other", key: "ACME-99" })],
    });
    const row = await pinRow(slot);
    expect(within(row).queryByText("ACME-99")).toBeNull();
  });

  it("keeps the pin usable when decisions cannot be read", async () => {
    const { slot } = mount({ decisionsFail: true });
    const row = await pinRow(slot);
    within(row).getByRole("button", { name: "Make task" });
  });

  it("re-reads decisions on focus and on a timer while cards are shown", async () => {
    const { slot, counts } = mount({ items: [decisionOf()] });
    const row = await pinRow(slot);
    await within(row).findByText("Which door first?");
    const afterLoad = counts.decisions;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(counts.decisions).toBeGreaterThan(afterLoad));
    expect(PIN_DECISIONS_REFRESH_MS).toBe(30_000);
  });
});
