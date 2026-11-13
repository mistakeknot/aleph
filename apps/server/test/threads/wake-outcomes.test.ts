import { events, type AppendStoredThreadEventArgs } from "@bb/db";
import {
  turnScope,
  type ThreadEventItem,
  type ThreadEventType,
  type WakeAttribution,
} from "@bb/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appendClientTurnEvent,
  appendThreadEvent,
} from "../../src/services/threads/thread-events.js";
import { readWakeOutcomes } from "../../src/services/threads/wake-turn-outcome.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const reportSchema = z.object({
  outcomes: z.array(
    z.object({
      turnId: z.string(),
      wakeCause: z.string(),
      wakeRef: z.string().nullable(),
      toolCount: z.number().nullable(),
      changedAnything: z.union([z.boolean(), z.literal("unknown")]),
      effectKinds: z.array(z.string()),
      coverage: z.object({ tools: z.string(), effects: z.string() }),
      requests: z.array(
        z.object({
          requestId: z.string(),
          wakeCause: z.string(),
          wakeRef: z.string().nullable(),
          postAcceptToolCount: z.number().nullable(),
          partialObservationWindow: z.boolean(),
          firstAcceptingTurnId: z.string(),
          retryOfRequestId: z.string().nullable(),
          retryAttempt: z.number().nullable(),
          retainedCause: z.string().nullable(),
        }),
      ),
    }),
  ),
  summary: z.object({
    completedTurns: z.number(),
    unknownCauseRate: z.number().nullable(),
    unknownEffectRate: z.number().nullable(),
  }),
});

function fixture(harness: TestAppHarness) {
  const { thread } = seedThreadFixture(harness);
  function append(
    event: {
      [K in ThreadEventType]: Omit<AppendStoredThreadEventArgs<K>, "threadId">;
    }[ThreadEventType],
  ) {
    appendThreadEvent(harness.deps, { ...event, threadId: thread.id });
  }
  function start(turnId: string) {
    append({
      type: "turn/started",
      scope: turnScope(turnId),
      data: { providerThreadId: "provider-1" },
    });
  }
  function finish(turnId: string) {
    append({
      type: "turn/completed",
      scope: turnScope(turnId),
      data: { providerThreadId: "provider-1", status: "completed" },
    });
  }
  function finishThenPruneStart(turnId: string) {
    start(turnId);
    finish(turnId);
    harness.db
      .delete(events)
      .where(
        and(
          eq(events.threadId, thread.id),
          eq(events.turnId, turnId),
          eq(events.type, "turn/started"),
        ),
      )
      .run();
  }
  function item(turnId: string, value: ThreadEventItem) {
    append({
      type: "item/completed",
      scope: turnScope(turnId),
      data: { providerThreadId: "provider-1", item: value },
    });
  }
  function request(
    wake: WakeAttribution = {},
    retryOf?: { requestId: string; attempt: number },
  ) {
    return appendClientTurnEvent(harness.deps, {
      ...wake,
      retryOf,
      threadId: thread.id,
      environmentId: thread.environmentId,
      type: "client/turn/requested",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      originPluginId: null,
      input: [
        {
          type: "text",
          text: "fixture body must not appear in reports",
          mentions: [],
        },
      ],
      target: { kind: "new-turn" },
      requestMethod: "turn/start",
      execution: {
        model: "example-model",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        source: "client/turn/requested",
      },
    }).requestId;
  }
  function accept(turnId: string, requestId: string) {
    append({
      type: "turn/input/accepted",
      scope: turnScope(turnId),
      data: { providerThreadId: "provider-1", clientRequestId: requestId },
    });
  }
  async function report() {
    const response = await harness.app.request(
      `/api/v1/threads/${thread.id}/wake-outcomes`,
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).not.toContain(
      "fixture body must not appear in reports",
    );
    return reportSchema.parse(body);
  }
  function outcomeEvents() {
    return harness.db
      .select()
      .from(events)
      .where(eq(events.threadId, thread.id))
      .all()
      .filter(
        (row) =>
          row.type === "system/operation" &&
          JSON.parse(row.data).operation === "wake.turn-outcome.v1",
      );
  }
  return {
    thread,
    start,
    finish,
    finishThenPruneStart,
    item,
    request,
    accept,
    report,
    outcomeEvents,
  };
}

const read: ThreadEventItem = {
  type: "fileRead",
  id: "read-1",
  path: "example.txt",
  status: "completed",
};
const write: ThreadEventItem = {
  type: "fileChange",
  id: "write-1",
  status: "completed",
  approvalStatus: null,
  changes: [
    { path: "example.txt", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
  ],
};

describe("wake outcome report HTTP contract", () => {
  it("bounds turn selection without dropping incomplete or missing-start terminal turns", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      appendThreadEvent(harness.deps, {
        threadId: f.thread.id,
        scope: turnScope("nested"),
        type: "turn/started",
        data: {
          providerThreadId: "provider-1",
          parentToolCallId: "parent-tool",
        },
      });
      f.finish("nested");
      f.finishThenPruneStart("missing-start");
      f.start("incomplete");
      for (let index = 0; index < 98; index++) f.start(`turn-${index}`);
      const response = await harness.app.request(
        `/api/v1/threads/${f.thread.id}/wake-outcomes`,
      );
      expect(await response.json()).toMatchObject({ truncated: false });
      const first = await f.report();
      expect(first.outcomes).toHaveLength(100);
      expect(first.outcomes.slice(0, 2)).toMatchObject([
        {
          turnId: "missing-start",
          toolCount: null,
          changedAnything: "unknown",
          coverage: { tools: "unknown", effects: "unknown" },
        },
        {
          turnId: "incomplete",
          toolCount: null,
          changedAnything: "unknown",
          coverage: { tools: "unknown", effects: "unknown" },
        },
      ]);
      expect(f.outcomeEvents()).toEqual([]);
      f.finishThenPruneStart("overflow-missing-start");
      const overflow = await harness.app.request(
        `/api/v1/threads/${f.thread.id}/wake-outcomes`,
      );
      expect(await overflow.json()).toMatchObject({ truncated: true });
      expect((await f.report()).outcomes).toEqual(first.outcomes);
    });
  });

  it("snapshots only the requested turn while finding its original acceptance across history", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const requestId = f.request({
        wakeCause: "message",
        wakeRef: "original",
      });
      f.start("original");
      f.accept("original", requestId);
      f.finish("original");
      for (let index = 0; index < 101; index++) f.start(`history-${index}`);
      f.start("target");
      f.accept("target", requestId);
      f.finish("target");
      const readTarget = () =>
        readWakeOutcomes(harness.deps, {
          threadId: f.thread.id,
          snapshotTurnId: "target",
        });
      expect(readTarget()).toMatchObject({
        truncated: false,
        outcomes: [
          {
            turnId: "target",
            toolCount: null,
            changedAnything: "unknown",
            requests: [
              {
                requestId,
                firstAcceptingTurnId: "original",
                wakeRef: "original",
              },
            ],
          },
        ],
      });
      const sealed = f.outcomeEvents();
      expect(sealed).toHaveLength(1);
      expect(sealed[0]?.turnId).toBe("target");
      f.item("target", write);
      f.item("target", write);
      expect(readTarget().outcomes).toMatchObject([
        { changedAnything: true, effectKinds: ["file"] },
      ]);
      expect(f.outcomeEvents()).toEqual(sealed);
    });
  });

  it("reports opaque effects as unknown without hiding known wake causes", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const request = f.request({ wakeCause: "message", wakeRef: "note-1" });
      f.start("turn-1");
      f.accept("turn-1", request);
      f.item("turn-1", {
        type: "commandExecution",
        id: "shell-1",
        command: "cat example.txt",
        cwd: "/tmp/example",
        status: "completed",
        approvalStatus: null,
        exitCode: 0,
      });
      f.finish("turn-1");
      const report = await f.report();
      expect(report.summary).toEqual({
        completedTurns: 1,
        unknownCauseRate: 0,
        unknownEffectRate: 1,
      });
      expect(report.outcomes[0]).toMatchObject({
        changedAnything: "unknown",
        effectKinds: [],
        toolCount: null,
        coverage: { tools: "unknown", effects: "unknown" },
      });
    });
  });

  it("admits an existing thread with no turns and does not invent zero-denominator rates", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      expect(await f.report()).toEqual({
        outcomes: [],
        summary: {
          completedTurns: 0,
          unknownCauseRate: null,
          unknownEffectRate: null,
        },
      });
      expect(f.outcomeEvents()).toEqual([]);
    });
  });

  it("joins only accepted IDs, orders by acceptance, and exposes steer windows without double counting turns", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const later = f.request({ wakeCause: "card_pick", wakeRef: "pick-1" });
      const primary = f.request({ wakeCause: "message", wakeRef: "note-1" });
      f.request({ wakeCause: "timer", wakeRef: "never-accepted" });
      f.start("turn-1");
      f.accept("turn-1", primary);
      f.item("turn-1", read);
      f.accept("turn-1", later);
      f.accept("turn-1", later);
      f.item("turn-1", { ...read, id: "read-2" });
      f.item("turn-1", { ...read, id: "read-2" });
      f.finish("turn-1");
      const report = await f.report();
      expect(report.summary).toMatchObject({ completedTurns: 1 });
      expect(report.outcomes).toHaveLength(1);
      expect(report.outcomes[0]).toMatchObject({
        turnId: "turn-1",
        wakeCause: "unknown",
        wakeRef: "note-1",
        toolCount: null,
        changedAnything: "unknown",
        coverage: { tools: "unknown", effects: "unknown" },
        requests: [
          {
            requestId: primary,
            wakeCause: "message",
            wakeRef: "note-1",
            postAcceptToolCount: null,
            partialObservationWindow: false,
          },
          {
            requestId: later,
            wakeCause: "card_pick",
            wakeRef: "pick-1",
            postAcceptToolCount: null,
            partialObservationWindow: true,
            firstAcceptingTurnId: "turn-1",
          },
        ],
      });
      f.start("turn-2");
      f.accept("turn-2", later);
      f.finish("turn-2");
      const next = await f.report();
      expect(
        next.outcomes.find((row) => row.turnId === "turn-2")?.requests,
      ).toEqual([
        expect.objectContaining({
          requestId: later,
          firstAcceptingTurnId: "turn-1",
        }),
      ]);
    });
  });

  it("refreshes late items on read while retaining one immutable outcome event", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const request = f.request({ wakeCause: "card_pick", wakeRef: "pick-1" });
      f.start("turn-1");
      f.accept("turn-1", request);
      f.item("turn-1", read);
      f.finish("turn-1");
      const first = await f.report();
      expect(first.outcomes[0]).toMatchObject({
        toolCount: null,
        changedAnything: "unknown",
        coverage: { tools: "unknown", effects: "unknown" },
      });
      expect(first.summary.unknownEffectRate).toBe(1);
      const sealed = f.outcomeEvents();
      expect(sealed).toHaveLength(1);
      expect(await f.report()).toEqual(first);
      f.item("turn-1", write);
      f.finish("turn-1");
      const late = await f.report();
      expect(late.outcomes[0]).toMatchObject({
        toolCount: null,
        changedAnything: true,
        effectKinds: ["file"],
        coverage: { tools: "unknown", effects: "unknown" },
      });
      expect(late.summary.unknownEffectRate).toBe(0);
      expect(await f.report()).toEqual(late);
      expect(f.outcomeEvents()).toEqual(sealed);
    });
  });

  it("keeps retry attempts separate and retains original attribution", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const original = f.request({ wakeCause: "card_pick", wakeRef: "pick-1" });
      f.start("turn-original");
      f.accept("turn-original", original);
      f.item("turn-original", { ...write, status: "failed" });
      f.finish("turn-original");
      const retry = f.request(
        { wakeCause: "restart", retainedCause: "card_pick", wakeRef: "pick-1" },
        { requestId: original, attempt: 2 },
      );
      f.start("turn-retry");
      f.accept("turn-retry", retry);
      f.item("turn-retry", write);
      f.finish("turn-retry");
      const report = await f.report();
      expect(report.outcomes).toHaveLength(2);
      expect(
        report.outcomes.find((row) => row.turnId === "turn-original"),
      ).toMatchObject({
        toolCount: null,
        changedAnything: "unknown",
        effectKinds: [],
        coverage: { tools: "unknown", effects: "unknown" },
      });
      expect(report.summary.unknownEffectRate).toBe(0.5);
      expect(
        report.outcomes.find((row) => row.turnId === "turn-retry"),
      ).toMatchObject({
        wakeCause: "restart",
        toolCount: null,
        changedAnything: true,
        coverage: { tools: "unknown", effects: "unknown" },
        requests: [
          {
            requestId: retry,
            retryOfRequestId: original,
            retryAttempt: 2,
            retainedCause: "card_pick",
          },
        ],
      });
      expect(f.outcomeEvents()).toHaveLength(2);
    });
  });

  it("does not seal an incomplete turn or attribute an unmatched request by timestamp", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      f.request({ wakeCause: "card_pick", wakeRef: "unaccepted" });
      f.start("turn-1");
      f.item("turn-1", read);
      const incomplete = await f.report();
      expect(incomplete.outcomes).toHaveLength(1);
      expect(incomplete.outcomes[0]).toMatchObject({
        wakeCause: "unknown",
        wakeRef: null,
        requests: [],
        toolCount: null,
        changedAnything: "unknown",
      });
      expect(incomplete.summary.completedTurns).toBe(0);
      expect(f.outcomeEvents()).toEqual([]);
      f.finish("turn-1");
      const complete = await f.report();
      expect(complete.summary).toMatchObject({
        completedTurns: 1,
        unknownCauseRate: 1,
      });
      expect(complete.outcomes[0]).toMatchObject({
        wakeCause: "unknown",
        wakeRef: null,
        requests: [],
      });
      expect(f.outcomeEvents()).toHaveLength(1);
    });
  });
});

it("does not infer complete telemetry from lifecycle events alone", async () => {
  await withTestHarness(async (harness) => {
    const f = fixture(harness);
    const requestId = f.request({ wakeCause: "message" });
    f.start("lifecycle-only");
    f.accept("lifecycle-only", requestId);
    f.finish("lifecycle-only");
    const report = await f.report();
    expect(report.outcomes[0]).toMatchObject({
      toolCount: null,
      changedAnything: "unknown",
      coverage: { tools: "unknown", effects: "unknown" },
      requests: [{ requestId, postAcceptToolCount: null }],
    });
    expect(report.summary.unknownEffectRate).toBe(1);
  });
});
