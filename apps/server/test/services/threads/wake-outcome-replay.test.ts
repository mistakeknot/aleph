import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  createProject,
  createThread,
  events,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { turnScope } from "@bb/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendThreadEvent } from "../../../src/services/threads/thread-events.js";
import {
  readWakeOutcomes,
  recordAcknowledgedWakeEffect,
} from "../../../src/services/threads/wake-turn-outcome.js";
import { NotificationHub } from "../../../src/ws/hub.js";

describe("durable wake effect acknowledgements", () => {
  it.each(["task", "card", "outbound_message"] as const)(
    "persists accepted %s acknowledgements and replays after reopening the database",
    async (effectKind) => {
      const directory = await mkdtemp(join(tmpdir(), "wake-replay-"));
      const original = createMigratedConnection();
      let reopened: ReturnType<typeof createConnection> | undefined;
      try {
        const host = upsertHost(original, noopNotifier, {
          name: "example.test",
        });
        const { project } = createProject(original, noopNotifier, {
          name: "example",
          source: { type: "local_path", hostId: host.id, path: "/tmp/example" },
        });
        const thread = createThread(original, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
        });
        const deps = { db: original, hub: new NotificationHub() };
        appendThreadEvent(deps, {
          threadId: thread.id,
          scope: turnScope("turn-1"),
          type: "turn/started",
          data: { providerThreadId: "provider-1" },
        });
        const effect = {
          caller: { threadId: thread.id, turnId: "turn-1" },
          operationId: "operation-1",
          effectKind,
          acknowledged: true,
          changed: true,
        };
        await recordAcknowledgedWakeEffect(deps, {
          ...effect,
          acknowledged: false,
        });
        await recordAcknowledgedWakeEffect(deps, { ...effect, changed: false });
        expect(
          original
            .select()
            .from(events)
            .where(eq(events.threadId, thread.id))
            .all()
            .filter((row) => row.type === "system/operation"),
        ).toEqual([]);
        await recordAcknowledgedWakeEffect(deps, effect);
        await recordAcknowledgedWakeEffect(deps, effect);
        appendThreadEvent(deps, {
          threadId: thread.id,
          scope: turnScope("turn-1"),
          type: "turn/completed",
          data: { providerThreadId: "provider-1", status: "completed" },
        });
        const before = await readWakeOutcomes(deps, { threadId: thread.id });
        expect(before.outcomes).toHaveLength(1);
        expect(before.outcomes[0]).toMatchObject({
          changedAnything: true,
          effectKinds: [effectKind],
        });
        const rows = original
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all();
        const operations = rows.filter(
          (row) => row.type === "system/operation",
        );
        expect(
          operations.filter(
            (row) => JSON.parse(row.data).operation === "wake.effect.v1",
          ),
        ).toHaveLength(1);
        expect(
          operations.filter(
            (row) => JSON.parse(row.data).operation === "wake.turn-outcome.v1",
          ),
        ).toHaveLength(1);
        const path = join(directory, "replay.sqlite");
        await original.$client.backup(path);
        original.$client.close();
        reopened = createConnection(path);
        const freshDeps = { db: reopened, hub: new NotificationHub() };
        expect(
          await readWakeOutcomes(freshDeps, { threadId: thread.id }),
        ).toEqual(before);
        await recordAcknowledgedWakeEffect(freshDeps, effect);
        expect(
          await readWakeOutcomes(freshDeps, { threadId: thread.id }),
        ).toEqual(before);
        expect(
          reopened
            .select()
            .from(events)
            .where(eq(events.threadId, thread.id))
            .all(),
        ).toEqual(rows);
      } finally {
        if (original.$client.open) original.$client.close();
        reopened?.$client.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not guess the caller turn for an unacknowledged or unattributed effect", async () => {
    const db = createMigratedConnection();
    try {
      const deps = { db, hub: new NotificationHub() };
      for (const acknowledged of [false, true]) {
        await recordAcknowledgedWakeEffect(deps, {
          caller: null,
          operationId: "operation-unattributed",
          effectKind: "outbound_message",
          acknowledged,
          changed: true,
        });
      }
      expect(db.select().from(events).all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  });
});
