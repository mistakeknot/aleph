import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createQueuedThreadMessage,
  createThread,
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
