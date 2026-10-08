import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createQueuedThreadMessage,
  createThread,
  getTransferOperation,
  migrate,
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

const heldWait = {
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
      dataDir: await mkdtemp(join(tmpdir(), "bb-transfer-delivery-")),
      appVersion: "0.9.0",
    },
  });
}

type Handler = (payload: {
  entry: { id: string };
  transfer?: Record<string, unknown>;
}) => unknown;

function installHandler(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  handler: Handler,
) {
  runtime.loaded.set("plug-1", {
    handle: { threadEventHandlers: { "message.queued": [handler] } },
  } as never);
  setPluginThreadEventEmitter({
    deliverMessageQueuedTransfer: runtime.buildQueuedMessageTransferDeliverer(),
  } as never);
}

function seed() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "delivery" });
  const { project } = createProject(db, noopNotifier, {
    name: "delivery",
    source: { type: "local_path", hostId: host.id, path: "/tmp/delivery" },
  });
  const source = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const target = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  createQueuedThreadMessage(db, noopNotifier, {
    threadId: source.id,
    content: textInput("held"),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: heldWait,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
  const outcome = retireQueuedThreadMessages(db, {
    projectId: project.id,
    sourceThreadId: source.id,
    targetThreadId: target.id,
    operationKey: "delivery-key",
    retireEnabled: true,
    resolveWaitingOn: () => heldWait,
  });
  if (outcome.kind !== "retired") throw new Error(outcome.kind);
  const deps = {
    db,
    hub: { notifyThread: () => 0 },
  } as never;
  const unemitted = () =>
    (
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM transfer_events WHERE emitted_at IS NULL",
        )
        .get() as { n: number }
    ).n;
  return { db, deps, outcome, unemitted, project };
}

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
});

describe("transfer event delivery on the real plugin runtime", () => {
  it("delivers after a crash before delivery, with event identity, and stamps only after the handler completes", async () => {
    const { deps, unemitted, outcome } = seed();
    expect(unemitted()).toBeGreaterThan(0);
    const runtime = await createRuntime((deps as { db: DbConnection }).db);
    const received: Parameters<Handler>[0][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installHandler(runtime, async (payload) => {
      received.push(payload);
      await gate;
    });
    const drain = drainTransferLedger(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);
    expect(unemitted()).toBeGreaterThan(0);
    release();
    await drain;
    expect(unemitted()).toBe(0);
    expect(received[0]?.transfer).toMatchObject({
      operationId: outcome.operationId,
      kind: "moved",
      state: "terminal",
    });
    expect(typeof received[0]?.transfer?.eventId).toBe("number");
    expect(typeof received[0]?.transfer?.entryId).toBe("string");
    expect(received[0]?.transfer?.originId).toBeTruthy();
    expect(received[0]?.entry.id).toBe(received[0]?.transfer?.rowId);
  });

  it("leaves the event unstamped when the handler throws and retries until it succeeds", async () => {
    const { db, deps, unemitted, outcome, project } = seed();
    const runtime = await createRuntime(db);
    let attempts = 0;
    let failing = true;
    const eventIds: unknown[] = [];
    installHandler(runtime, (payload) => {
      attempts += 1;
      eventIds.push(payload.transfer?.eventId);
      if (failing) throw new Error("consumer unavailable");
    });
    await drainTransferLedger(deps);
    expect(attempts).toBe(1);
    expect(unemitted()).toBeGreaterThan(0);
    await drainTransferLedger(deps);
    expect(attempts).toBe(2);
    expect(unemitted()).toBeGreaterThan(0);
    failing = false;
    await drainTransferLedger(deps);
    expect(attempts).toBe(3);
    expect(unemitted()).toBe(0);
    expect(new Set(eventIds).size).toBe(1);
    await drainTransferLedger(deps);
    expect(attempts).toBe(3);
    expect(getTransferOperation(db, outcome.operationId)).not.toBeNull();
    void project;
  });

  it("does not sweep an operation whose delivery has not completed", async () => {
    const { db, deps, outcome, project } = seed();
    const runtime = await createRuntime(db);
    installHandler(runtime, () => {
      throw new Error("down");
    });
    db.$client
      .prepare("UPDATE transfer_operations SET acked_at = ? WHERE id = ?")
      .run(Date.now(), outcome.operationId);
    await drainTransferLedger(deps);
    expect(getTransferOperation(db, outcome.operationId)).not.toBeNull();
    void project;
  });

  it("stamps events straight away when no plugin is listening", async () => {
    const { db, deps, unemitted } = seed();
    await createRuntime(db);
    setPluginThreadEventEmitter({
      deliverMessageQueuedTransfer: async () => true,
    } as never);
    await drainTransferLedger(deps);
    expect(unemitted()).toBe(0);
  });
});
