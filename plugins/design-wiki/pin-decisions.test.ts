import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { claimMarkerFor } from "./pin-anchor.js";
import plugin from "./server.js";

const ROOT = "/work/proj";
const CUJ = `${ROOT}/docs/wiki/src/cujs/boss.md`;
const TAG = "design-wiki:pin-decisions:p1";

function pageText(claimLine: string, card: string): string {
  return `---\nid: cuj-boss\nstatus: open\ncard: "${card}"\nsource: docs/x.md\nupdated: 2026-11-03\n---\n\n# Boss\n\n${claimLine}\ntext\n`;
}

const CLAIM_LINE = "**Open: first question ACME-35**";
const CLAIM = {
  label: "Open: first question ACME-35",
  context: CLAIM_LINE,
  ordinal: 0,
  groupSize: 1,
};

interface Ask {
  id: string;
  key: string;
  revision: string;
  ask: Record<string, unknown>;
}

interface Autarch {
  cards: Map<string, { state: string; title: string }>;
  owed: Ask[];
  failing: Set<string>;
  pickResult: Record<string, unknown>;
  calls: { method: string; input: unknown }[];
}

function decide(
  key: string,
  extra: Record<string, unknown> = {},
  revision = "rev-1",
): Ask {
  return {
    id: `dec-${key}`,
    key,
    revision,
    ask: {
      kind: "decide",
      question: `Which way for ${key}?`,
      recommendation: "a",
      options: [
        { id: "a", label: "Option A", instruction: "do a" },
        { id: "b", label: "Option B", instruction: "do b" },
      ],
      ...extra,
    },
  };
}

function newAutarch(): Autarch {
  return {
    cards: new Map([
      ["ACME-35", { state: "open", title: "First question" }],
      ["ACME-40", { state: "open", title: "Page card" }],
      ["ONE-1", { state: "open", title: "Task card" }],
    ]),
    owed: [decide("ACME-35"), decide("ACME-40"), decide("ONE-1")],
    failing: new Set(),
    pickResult: { ok: true },
    calls: [],
  };
}

function backend(autarch: Autarch) {
  return async (args: {
    pluginId: string;
    method: string;
    input?: unknown;
    outputSchema: { parse(value: unknown): unknown };
  }) => {
    const input = (args.input ?? {}) as Record<string, any>;
    let result: unknown;
    if (args.pluginId === "autarch") {
      autarch.calls.push({ method: args.method, input: args.input });
      if (autarch.failing.has(args.method)) {
        throw new Error(`autarch ${args.method} failed`);
      }
      if (args.method === "cardState") {
        const card = autarch.cards.get(input.key);
        result =
          card === undefined
            ? { found: false }
            : { found: true, state: card.state, title: card.title };
      } else if (args.method === "listAsks") {
        result = { owed: autarch.owed, later: [], recent: [] };
      } else if (args.method === "pick") {
        result = autarch.pickResult;
      } else {
        throw new Error(`unexpected autarch method ${args.method}`);
      }
    } else {
      throw new Error(`unexpected plugin ${args.pluginId}`);
    }
    return args.outputSchema.parse(JSON.parse(JSON.stringify(result)));
  };
}

async function setup() {
  const autarch = newAutarch();
  const state = { page: pageText(CLAIM_LINE, "ACME-40") };
  const host = createFakePluginHost({
    pluginId: "bb--design-wiki",
    sdk: {
      projects: {
        list: async () => [],
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "Proj",
          sources: [
            {
              type: "local_path",
              hostId: "host-1",
              path: ROOT,
              isDefault: true,
            },
          ],
        }),
      },
      threads: { get: async () => ({ id: "t1", projectId: "p1" }) },
      files: {
        listPaths: async ({ path }: { path: string }) => ({
          paths: [CUJ]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => ({
              kind: "file",
              path: file.slice(path.length + 1),
              name: "boss.md",
            })),
          truncated: false,
        }),
        read: async ({ path }: { path: string }) => ({
          path,
          content: state.page,
          contentEncoding: "utf8",
          sizeBytes: state.page.length,
          sha256: "x",
        }),
      },
      plugins: { callRpc: backend(autarch) },
    },
  });
  await plugin(host.bb);
  return { host, autarch, state };
}

type Fake = Awaited<ReturnType<typeof setup>>;

async function createPin(fake: Fake, claim: unknown = CLAIM) {
  const result = (await fake.host.harness.callRpc("createPin", {
    projectId: "p1",
    pageId: "cuj-boss",
    claim,
    body: "A pin",
  })) as { pin: { id: string } };
  return result.pin.id;
}

function linkTask(fake: Fake, pinId: string, key: string) {
  fake.host.bb.storage
    .database()
    .prepare(
      "INSERT INTO pin_tasks (pin_id, task_id, task_key, task_project_id, linked_at) VALUES (?, ?, ?, 'B1', 'now')",
    )
    .run(pinId, `id-${key}`, key);
}

async function decisions(fake: Fake) {
  return (await fake.host.harness.callRpc("pinDecisions", {
    projectId: "p1",
  })) as Record<string, any>[];
}

async function answer(fake: Fake, input: Record<string, unknown>) {
  return (await fake.host.harness.callRpc("answerPinDecision", {
    projectId: "p1",
    optionId: "a",
    revision: "rev-1",
    pickId: "pick-1",
    ...input,
  })) as Record<string, any>;
}

function calls(fake: Fake, method: string) {
  return fake.autarch.calls.filter((call) => call.method === method);
}

describe("claimMarkerFor", () => {
  it("finds the marker a claim target names and nothing for a stale target", async () => {
    const fake = await setup();
    const page = (await fake.host.harness.callRpc("page", {
      projectId: "p1",
      pageId: "cuj-boss",
    })) as { page: Parameters<typeof claimMarkerFor>[0] };
    expect(claimMarkerFor(page.page, CLAIM)?.cards).toEqual(["ACME-35"]);
    expect(claimMarkerFor(page.page, { ...CLAIM, groupSize: 2 })).toBeNull();
    expect(
      claimMarkerFor(page.page, { ...CLAIM, label: "Open: x" }),
    ).toBeNull();
  });
});

describe("pinDecisions: which cards a pin shows", () => {
  it("shows the claim's cards on a claim pin and not the page card", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const items = await decisions(fake);
    expect(items.map((item) => [item.pinId, item.key, item.origin])).toEqual([
      [pinId, "ACME-35", "claim"],
    ]);
  });

  it("shows the page card on a page pin", async () => {
    const fake = await setup();
    const pinId = await createPin(fake, null);
    const items = await decisions(fake);
    expect(items.map((item) => [item.pinId, item.key, item.origin])).toEqual([
      [pinId, "ACME-40", "page"],
    ]);
  });

  it("adds a card linked to the pin as a task card, and lists a shared key once", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    linkTask(fake, pinId, "ONE-1");
    linkTask(fake, pinId, "ACME-35");
    const keys = (await decisions(fake)).map((item) => [item.key, item.origin]);
    expect(keys).toEqual([
      ["ACME-35", "claim"],
      ["ONE-1", "task"],
    ]);
  });

  it("shows only task cards on a detached pin", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    linkTask(fake, pinId, "ONE-1");
    fake.state.page = pageText("**Open: changed**", "ACME-40");
    const items = await decisions(fake);
    expect(items.map((item) => [item.key, item.origin])).toEqual([
      ["ONE-1", "task"],
    ]);
  });

  it("shows only task cards on an unverified pin", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    linkTask(fake, pinId, "ONE-1");
    fake.state.page = "not a wiki page";
    const items = await decisions(fake);
    expect(items.map((item) => [item.key, item.origin])).toEqual([
      ["ONE-1", "task"],
    ]);
  });

  it("returns nothing and asks nobody when no pin has a card", async () => {
    const fake = await setup();
    fake.state.page = pageText("**Open: no card**", "");
    await createPin(fake, {
      label: "Open: no card",
      context: "**Open: no card**",
      ordinal: 0,
      groupSize: 1,
    });
    expect(await decisions(fake)).toEqual([]);
    expect(fake.autarch.calls).toEqual([]);
  });
});

describe("pinDecisions: what each card reports", () => {
  it("offers the options of an open decision with its revision", async () => {
    const fake = await setup();
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item).toMatchObject({
      key: "ACME-35",
      state: "open",
      title: "First question",
      reason: null,
      answer: {
        decisionId: "dec-ACME-35",
        revision: "rev-1",
        question: "Which way for ACME-35?",
        recommendation: "a",
        options: [
          { id: "a", label: "Option A" },
          { id: "b", label: "Option B" },
        ],
      },
    });
  });

  it("reports a closed card without an answer", async () => {
    const fake = await setup();
    fake.autarch.cards.set("ACME-35", { state: "closed", title: "Done" });
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item).toMatchObject({ state: "closed", answer: null });
  });

  it("reports a card the decision queue does not know", async () => {
    const fake = await setup();
    fake.autarch.cards.delete("ACME-35");
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item).toMatchObject({ state: "missing", answer: null });
  });

  it("links only, with a reason, when the open card has no listed decision", async () => {
    const fake = await setup();
    fake.autarch.owed = [];
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item.state).toBe("open");
    expect(item.answer).toBeNull();
    expect(item.reason).toMatch(/not waiting/i);
  });

  it.each([
    ["an approval ask", { kind: "approve" }],
    ["a multi-question ask", { questions: [{ id: "q1" }] }],
    [
      "an option that needs an approval",
      {
        options: [
          { id: "a", label: "Option A", approval: { kind: "pr" } },
          { id: "b", label: "Option B" },
        ],
      },
    ],
    ["an ask with no options", { options: [] }],
  ])("does not offer an answer for %s", async (_name, extra) => {
    const fake = await setup();
    fake.autarch.owed = [decide("ACME-35", extra)];
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item.answer).toBeNull();
    expect(item.reason).toMatch(/open the card/i);
  });

  it("reports the card as unavailable when the decision queue is down", async () => {
    const fake = await setup();
    fake.autarch.failing.add("cardState");
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item).toMatchObject({ state: "unavailable", answer: null });
    expect(item.reason).toMatch(/could not reach/i);
  });

  it("keeps the card state when only the ask list is unreachable", async () => {
    const fake = await setup();
    fake.autarch.failing.add("listAsks");
    await createPin(fake);
    const [item] = await decisions(fake);
    expect(item).toMatchObject({ state: "open", answer: null });
    expect(item.reason).toMatch(/could not reach/i);
  });

  it("reads a key Citadel could not hold as missing without asking it", async () => {
    const tooLong = `ACME-${"1".repeat(8)}`;
    const fake = await setup();
    fake.state.page = pageText(`**Open: odd ${tooLong}**`, "");
    await createPin(fake, {
      label: `Open: odd ${tooLong}`,
      context: `**Open: odd ${tooLong}**`,
      ordinal: 0,
      groupSize: 1,
    });
    const [item] = await decisions(fake);
    expect(item).toMatchObject({ key: tooLong, state: "missing" });
    expect(fake.autarch.calls).toEqual([]);
  });
});

describe("answerPinDecision", () => {
  it("answers with the shown revision and the client's pick id, then invalidates", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.host.harness.experimental_rpcInvalidations.length = 0;
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toEqual({ ok: true });
    expect(calls(fake, "pick")).toEqual([
      {
        method: "pick",
        input: {
          decision_id: "dec-ACME-35",
          option_id: "a",
          revision: "rev-1",
          pick_id: "pick-1",
        },
      },
    ]);
    expect(fake.host.harness.experimental_rpcInvalidations.flat(2)).toContain(
      TAG,
    );
  });

  it("reports a stale revision and does not retry", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.pickResult = {
      ok: false,
      status: 409,
      error: "revision differs",
    };
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
    expect(result.message).toMatch(/changed/i);
    expect(calls(fake, "pick")).toHaveLength(1);
  });

  it("reports another refusal as refused with Citadel's words", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.pickResult = { ok: false, status: 400, error: "bad option" };
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "refused" });
    expect(result.message).toContain("bad option");
    expect(calls(fake, "pick")).toHaveLength(1);
  });

  it("reports a failed pick as unconfirmed, never as unanswered, and does not retry", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.failing.add("pick");
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "unknown" });
    expect(result.message).toMatch(/could not confirm/i);
    expect(result.message).not.toMatch(/nothing was answered/i);
    expect(calls(fake, "pick")).toHaveLength(1);
    expect(fake.host.harness.experimental_rpcInvalidations.flat(2)).toContain(
      TAG,
    );
  });

  it("says nothing was answered when the queue cannot be read before any pick", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.failing.add("listAsks");
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.message).toMatch(/nothing was answered/i);
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("never sends a malformed key to Citadel on the answer path", async () => {
    const tooLong = `ACME-${"1".repeat(8)}`;
    const fake = await setup();
    fake.state.page = pageText(`**Open: odd ${tooLong}**`, "");
    const pinId = await createPin(fake, {
      label: `Open: odd ${tooLong}`,
      context: `**Open: odd ${tooLong}**`,
      ordinal: 0,
      groupSize: 1,
    });
    const result = await answer(fake, { pinId, key: tooLong });
    expect(result).toMatchObject({ ok: false, reason: "not-linked" });
    expect(fake.autarch.calls).toEqual([]);
  });

  it("refuses a key that is not one of the pin's cards", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const result = await answer(fake, { pinId, key: "ACME-40" });
    expect(result).toMatchObject({ ok: false, reason: "not-linked" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("refuses an unknown pin", async () => {
    const fake = await setup();
    const result = await answer(fake, { pinId: "nope", key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("refuses a card that is no longer waiting", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.owed = [];
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "not-open" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("refuses a card that cannot be answered here", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.autarch.owed = [decide("ACME-35", { kind: "approve" })];
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "not-answerable" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("refuses an option the decision does not offer", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const result = await answer(fake, {
      pinId,
      key: "ACME-35",
      optionId: "zzz",
    });
    expect(result).toMatchObject({ ok: false, reason: "not-answerable" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("refuses a detached pin's claim card", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    fake.state.page = pageText("**Open: changed**", "ACME-40");
    const result = await answer(fake, { pinId, key: "ACME-35" });
    expect(result).toMatchObject({ ok: false, reason: "not-linked" });
    expect(calls(fake, "pick")).toHaveLength(0);
  });

  it("answers a task card of a detached pin", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    linkTask(fake, pinId, "ONE-1");
    fake.state.page = pageText("**Open: changed**", "ACME-40");
    const result = await answer(fake, { pinId, key: "ONE-1" });
    expect(result).toEqual({ ok: true });
  });
});
