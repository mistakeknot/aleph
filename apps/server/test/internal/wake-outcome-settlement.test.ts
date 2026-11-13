import { getThread, listEvents } from "@bb/db";
import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import { appendThreadEvent } from "../../src/services/threads/thread-events.js";
import {
  readWakeOutcomes,
  recordAcknowledgedWakeEffect,
} from "../../src/services/threads/wake-turn-outcome.js";
import { seedStoredEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("optional wake telemetry during settlement", () => {
  it("settles legacy completions and fails reports without inventing completion counts", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        type: "turn/started",
        data: { providerThreadId: "provider-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "turn/completed",
        data: { status: "completed", privateBody: "must-not-escape" },
      });
      const before = listEvents(harness.db, { threadId: thread.id });
      expect(
        applyTurnCompletedEvent(harness.deps, {
          afterIdle: null,
          payload: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            status: "completed",
          },
        }),
      ).toEqual({ kind: "settled", nextStatus: "idle" });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/wake-outcomes`,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "internal_error",
        message: "Wake outcome identity or completion evidence is incomplete",
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(before);
    });
  });

  it.each([false, true])(
    "preserves valid effects with malformed telemetry (effect: %s)",
    async (hasEffect) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness, {
          thread: { status: "active" },
        });
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-1"),
          type: "turn/started",
          data: { providerThreadId: "provider-1" },
        });
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-1"),
          sequence: 2,
          type: "item/completed",
          data: { item: { type: "toolCall", privateBody: "must-not-escape" } },
        });
        if (hasEffect)
          recordAcknowledgedWakeEffect(harness.deps, {
            caller: { threadId: thread.id, turnId: "turn-1" },
            operationId: "effect-1",
            effectKind: "task",
            acknowledged: true,
            changed: true,
          });
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-1"),
          type: "turn/completed",
          data: { providerThreadId: "provider-1", status: "completed" },
        });
        expect(
          applyTurnCompletedEvent(harness.deps, {
            afterIdle: null,
            payload: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              status: "completed",
            },
          }),
        ).toEqual({ kind: "settled", nextStatus: "idle" });
        const expected = {
          turnId: "turn-1",
          completed: true,
          toolCount: null,
          changedAnything: hasEffect ? true : "unknown",
          effectKinds: hasEffect ? ["task"] : [],
          coverage: {
            tools: "unknown",
            effects: "unknown",
            attribution: "unknown",
          },
        };
        const report = readWakeOutcomes(harness.deps, { threadId: thread.id });
        expect(report.outcomes).toHaveLength(1);
        expect(report.outcomes[0]).toMatchObject(expected);
        expect(report.summary.completedTurns).toBe(1);
        expect(readWakeOutcomes(harness.deps, { threadId: thread.id })).toEqual(
          report,
        );
        const snapshots = listEvents(harness.db, {
          threadId: thread.id,
        }).filter(
          (row) =>
            row.type === "system/operation" &&
            JSON.parse(row.data).operation === "wake.turn-outcome.v1",
        );
        expect(snapshots).toHaveLength(1);
        expect(JSON.parse(snapshots[0]!.data).metadata).toMatchObject(expected);
      });
    },
  );

  it("settles when optional snapshot persistence fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        type: "turn/started",
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        type: "turn/completed",
        data: { providerThreadId: "provider-1", status: "completed" },
      });
      harness.db.$client.exec(`
        CREATE TEMP TRIGGER reject_wake_snapshot BEFORE INSERT ON events
        WHEN NEW.type = 'system/operation'
          AND json_extract(NEW.data, '$.operation') = 'wake.turn-outcome.v1'
        BEGIN SELECT RAISE(ABORT, 'private snapshot failure'); END;
      `);
      expect(
        applyTurnCompletedEvent(harness.deps, {
          afterIdle: null,
          payload: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            status: "completed",
          },
        }),
      ).toEqual({ kind: "settled", nextStatus: "idle" });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: thread.id }).map((row) => row.type),
      ).toEqual(["turn/started", "turn/completed"]);
      harness.db.$client.exec("DROP TRIGGER reject_wake_snapshot");
      expect(
        readWakeOutcomes(harness.deps, { threadId: thread.id }).outcomes[0],
      ).toMatchObject({ completed: true, toolCount: null });
      readWakeOutcomes(harness.deps, { threadId: thread.id });
      expect(
        listEvents(harness.db, { threadId: thread.id }).map((row) => row.type),
      ).toEqual(["turn/started", "turn/completed", "system/operation"]);
    });
  });
});
