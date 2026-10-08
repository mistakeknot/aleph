import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortTransferOperation,
  claimQueuedThreadMessage,
  createConnection,
  createProject,
  createQueuedThreadMessage,
  createThread,
  migrate,
  releaseQueuedMessageClaim,
  retireQueuedThreadMessages,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../src/services/ai/ai-service-registry.js";
import { createPluginRuntime } from "../../src/services/plugins/plugin-runtime.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { drainTransferLedger } from "../../src/services/threads/queued-messages.js";
import { createNoopTelemetryService } from "../../src/services/system/telemetry.js";
import { testLogger } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";

const noopNotifier = {
  notifyThread: () => {},
  notifyProject: () => {},
  notifyHost: () => {},
  notifySystem: () => {},
} as never;

const pluginWait = {
  kind: "plugin",
  pluginId: "plug-1",
  reason: "approval",
} as const;

async function createRuntime(db: DbConnection) {
  return createPluginRuntime({
    machineEnrollments: null,
    includedBuiltinNames: new Set(),
    deps: {
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger as unknown as Logger,
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      dataDir: await mkdtemp(join(tmpdir(), "bb-transfer-record-")),
      appVersion: "0.9.0",
    },
  });
}

interface Recorded {
  eventId: number;
  kind: string;
  state: string;
  entryRowId: string | null;
}

function install(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  handler: (payload: {
    entry: { id: string } | null;
    transfer: { eventId: number; kind: string; state: string };
  }) => unknown,
) {
  runtime.loaded.set("plug-1", {
    handle: {
      threadEventHandlers: {
        "message.transferred": [handler],
        "message.queued": [],
      },
    },
  } as never);
  setPluginThreadEventEmitter({
    deliverMessageQueuedTransfer: runtime.buildQueuedMessageTransferDeliverer(),
  } as never);
}

function seed(rows: number) {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "record" });
  const { project } = createProject(db, noopNotifier, {
    name: "record",
    source: { type: "local_path", hostId: host.id, path: "/tmp/record" },
  });
  const source = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const target = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  for (let i = 0; i < rows; i += 1) {
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: source.id,
      content: textInput(`held ${i}`),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: pluginWait,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
  }
  const outcome = retireQueuedThreadMessages(db, {
    projectId: project.id,
    sourceThreadId: source.id,
    targetThreadId: target.id,
    operationKey: "record-key",
    retireEnabled: true,
    resolveWaitingOn: () => pluginWait,
  });
  if (outcome.kind !== "retired") throw new Error(outcome.kind);
  const deps = { db, hub: { notifyThread: () => 0 } } as never;
  const stamped = () =>
    (
      db.$client
        .prepare(
          "SELECT event_id AS id FROM transfer_events WHERE emitted_at IS NOT NULL",
        )
        .all() as { id: number }[]
    ).map((row) => row.id);
  const total = () =>
    (
      db.$client.prepare("SELECT COUNT(*) AS n FROM transfer_events").get() as {
        n: number;
      }
    ).n;
  return { db, deps, stamped, total };
}

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
});

describe("every durable transfer record reaches a consumer before it is stamped", () => {
  it("hands a consumer each record it stamps, including records without a landed row", async () => {
    const { db, deps, stamped, total } = seed(1);
    const runtime = await createRuntime(db);
    const seen: Recorded[] = [];
    install(runtime, (payload) => {
      seen.push({
        eventId: payload.transfer.eventId,
        kind: payload.transfer.kind,
        state: payload.transfer.state,
        entryRowId: payload.entry?.id ?? null,
      });
    });
    await drainTransferLedger(deps);
    expect(total()).toBeGreaterThan(0);
    expect(stamped()).toHaveLength(total());
    expect([...seen.map((s) => s.eventId)].sort()).toEqual(
      [...stamped()].sort(),
    );
    expect(seen.some((s) => s.entryRowId !== null)).toBe(true);
  });

  it("delivers every record of a multi-row retirement", async () => {
    const { db, deps, stamped, total } = seed(3);
    const runtime = await createRuntime(db);
    const seen: number[] = [];
    install(runtime, (payload) => {
      seen.push(payload.transfer.eventId);
    });
    await drainTransferLedger(deps);
    expect(stamped()).toHaveLength(total());
    expect(new Set(seen).size).toBe(total());
  });

  it("does not stamp a record whose consumer failed", async () => {
    const { db, deps, stamped } = seed(1);
    const runtime = await createRuntime(db);
    install(runtime, () => {
      throw new Error("down");
    });
    await drainTransferLedger(deps);
    expect(stamped()).toHaveLength(0);
  });
});

interface Observed {
  eventId: number;
  kind: string;
  state: string;
  entryNull: boolean;
  emittedAtSeen: number | null;
  rowId: string | null;
}

function world() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "families" });
  const { project } = createProject(db, noopNotifier, {
    name: "families",
    source: { type: "local_path", hostId: host.id, path: "/tmp/families" },
  });
  const make = () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
  const source = make();
  const target = make();
  const enqueue = (
    threadId: string,
    text: string,
    overrides: Partial<Parameters<typeof createQueuedThreadMessage>[2]> = {},
  ) =>
    createQueuedThreadMessage(db, noopNotifier, {
      threadId,
      content: textInput(text),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: pluginWait,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
      ...overrides,
    });
  const retire = (key: string) => {
    const outcome = retireQueuedThreadMessages(db, {
      projectId: project.id,
      sourceThreadId: source.id,
      targetThreadId: target.id,
      operationKey: key,
      retireEnabled: true,
      resolveWaitingOn: () => pluginWait,
    });
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    return outcome.operationId;
  };
  const sql = (statement: string, ...params: unknown[]) =>
    db.$client.prepare(statement).run(...params);
  const deps = { db, hub: { notifyThread: () => 0 } } as never;
  return { db, project, source, target, make, enqueue, retire, sql, deps };
}

async function observe(
  w: ReturnType<typeof world>,
  drain: () => Promise<void> = () => drainTransferLedger(w.deps),
) {
  const runtime = await createRuntime(w.db);
  const seen: Observed[] = [];
  install(runtime, (payload) => {
    const row = w.db.$client
      .prepare(
        "SELECT emitted_at AS at FROM transfer_events WHERE event_id = ?",
      )
      .get(payload.transfer.eventId) as { at: number | null };
    seen.push({
      eventId: payload.transfer.eventId,
      kind: payload.transfer.kind,
      state: payload.transfer.state,
      entryNull: payload.entry === null,
      emittedAtSeen: row.at,
      rowId: (payload.entry as { id: string } | null)?.id ?? null,
    });
  });
  await drain();
  return seen;
}

function unstamped(w: ReturnType<typeof world>) {
  return (
    w.db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM transfer_events WHERE emitted_at IS NULL",
      )
      .get() as { n: number }
  ).n;
}

function events(w: ReturnType<typeof world>) {
  return w.db.$client
    .prepare(
      "SELECT event_id AS id, payload FROM transfer_events ORDER BY event_id",
    )
    .all() as { id: number; payload: string }[];
}

function expectEveryEventDeliveredBeforeStamp(
  w: ReturnType<typeof world>,
  seen: Observed[],
) {
  const all = events(w);
  expect(all.length).toBeGreaterThan(0);
  expect(unstamped(w)).toBe(0);
  expect(seen.map((s) => s.eventId).sort()).toEqual(
    all.map((e) => e.id).sort(),
  );
  for (const s of seen) expect(s.emittedAtSeen).toBeNull();
  for (const s of seen) {
    const stored = JSON.parse(
      all.find((e) => e.id === s.eventId)?.payload ?? "{}",
    ) as { kind: string; state: string };
    expect([s.kind, s.state]).toEqual([stored.kind, stored.state]);
  }
}

describe("rowless and formerly excluded transfer facts reach consumers before they are stamped", () => {
  it("delivers a pending slot fact", async () => {
    const w = world();
    const held = w.enqueue(w.source.id, "held", { waitingOn: null });
    expect(claimQueuedThreadMessage(w.db, noopNotifier, held.id)).toBeTruthy();
    w.retire("slot-pending");
    const seen = await observe(w);
    expect(seen.map((s) => [s.kind, s.state, s.entryNull])).toEqual([
      ["slot", "pending", true],
    ]);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers a terminal slot fact", async () => {
    const w = world();
    const held = w.enqueue(w.source.id, "held", { waitingOn: null });
    expect(claimQueuedThreadMessage(w.db, noopNotifier, held.id)).toBeTruthy();
    const op = w.retire("slot-terminal");
    w.sql("UPDATE transfer_entries SET state = 'terminal' WHERE op_id = ?", op);
    const seen = await observe(w);
    expect(seen.map((s) => [s.kind, s.state, s.entryNull])).toEqual([
      ["slot", "pending", true],
      ["slot", "terminal", true],
    ]);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers a forwarded slot with its landed row", async () => {
    const w = world();
    const held = w.enqueue(w.source.id, "held", { waitingOn: null });
    const claimed = claimQueuedThreadMessage(w.db, noopNotifier, held.id);
    if (!claimed) throw new Error("claim failed");
    w.retire("slot-forwarded");
    releaseQueuedMessageClaim(w.db, noopNotifier, {
      id: held.id,
      claimToken: claimed.claimToken,
    });
    const seen = await observe(w);
    expect(seen.map((s) => [s.kind, s.state])).toEqual([
      ["slot", "pending"],
      ["slot", "forwarded"],
    ]);
    expect(seen[0]?.entryNull).toBe(true);
    expect(seen[1]?.entryNull).toBe(false);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers a non-forwardable fact", async () => {
    const w = world();
    w.enqueue(w.source.id, "retry", {
      waitingOn: null,
      payload: {
        kind: "retry",
        retryOfTurnRequestId: "req",
        attempt: 2,
        reason: "rate",
      },
    });
    w.retire("not-forwardable");
    const seen = await observe(w);
    expect(seen.map((s) => [s.kind, s.state, s.entryNull])).toEqual([
      ["not_forwardable", "terminal", true],
    ]);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers a redirected arrival fact", async () => {
    const w = world();
    w.enqueue(w.source.id, "early");
    w.retire("redirected");
    w.enqueue(w.source.id, "late");
    const seen = await observe(w);
    const kinds = seen.map((s) => s.kind);
    expect(kinds).toContain("redirected");
    expect(seen.find((s) => s.kind === "redirected")?.entryNull).toBe(true);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers a moved fact whose landed row vanished", async () => {
    const w = world();
    w.enqueue(w.source.id, "held");
    w.retire("vanished");
    w.sql(
      "DELETE FROM queued_thread_messages WHERE thread_id = ?",
      w.target.id,
    );
    const seen = await observe(w);
    expect(seen.map((s) => [s.kind, s.state, s.entryNull])).toEqual([
      ["moved", "terminal", true],
    ]);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });

  it("delivers residual and returned facts of an abort", async () => {
    const w = world();
    const third = w.make();
    w.enqueue(w.source.id, "a");
    w.enqueue(w.source.id, "b");
    const op = w.retire("abort-source");
    const landed = w.db.$client
      .prepare(
        "SELECT id FROM queued_thread_messages WHERE thread_id = ? ORDER BY sort_key",
      )
      .all(w.target.id) as { id: string }[];
    w.sql(
      "UPDATE queued_thread_messages SET thread_id = ? WHERE id = ?",
      third.id,
      landed[0]?.id,
    );
    const aborted = abortTransferOperation(w.db, {
      projectId: w.project.id,
      operationId: op,
      expectedRetirementOperationId: op,
      operationKey: "abort-1",
      resolveWaitingOn: () => pluginWait,
    });
    expect(aborted.kind).toBe("aborted");
    const seen = await observe(w);
    const kinds = new Set(seen.map((s) => s.kind));
    expect(kinds.has("residual")).toBe(true);
    expect(kinds.has("returned")).toBe(true);
    expect(seen.find((s) => s.kind === "residual")?.entryNull).toBe(true);
    expectEveryEventDeliveredBeforeStamp(w, seen);
  });
});
