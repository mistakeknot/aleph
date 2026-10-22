import { setTimeout as sleep } from "node:timers/promises";
import { getThread } from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isThreadEventsCold } from "@bb/db";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import {
  withHotThreadHistory,
  type EventColdTierDeps,
} from "../../src/services/threads/event-cold-tier/service.js";
import { clearThreadContext } from "../../src/services/threads/thread-context-clear.js";
import {
  setPluginHookProvider,
  invokePluginInline,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  createAutomaticQueuedMessageGroupEligibility,
  sendQueuedMessage,
} from "../../src/services/threads/queued-messages.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  interruptActiveThreadsForHost,
  requestThreadStopForCurrentState,
  stopThreadForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  attemptColdMove,
  countThreadEvents,
  forceColdEligible,
  forceColdStateRow,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedQueuedMessage,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

let fixtureCounter = 0;

function seedFixture(
  harness: TestAppHarness,
  status: "active" | "idle" = "idle",
) {
  fixtureCounter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-gates-${fixtureCounter}` },
    environment: { path: `/tmp/cold-gates-${fixtureCounter}` },
    thread: { status },
  });
  seedColdTierEvents(harness.db, fixture.thread.id);
  const ids = {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    threadId: fixture.thread.id,
  };
  return { ...fixture, ids };
}

function coldDeps(harness: TestAppHarness): EventColdTierDeps {
  return harness.deps as unknown as EventColdTierDeps;
}

describe("cold tier pins around hot-path operations", () => {
  it("withHotThreadHistory refuses a move while suspended and releases after success and failure", async () => {
    await withTestHarness(async (harness) => {
      const { ids, thread } = seedFixture(harness);
      forceColdEligible(harness.db, ids);
      const gate = createDeferredPromise<void>();
      const running = withHotThreadHistory(
        coldDeps(harness),
        thread.id,
        () => gate.promise,
      );
      await sleep(5);
      expect(getThreadHistoryPinCount(thread.id)).toBe(1);
      const refused = await attemptColdMove(harness, thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      gate.resolve();
      await running;
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);

      await expect(
        withHotThreadHistory(coldDeps(harness), thread.id, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
      const moved = await attemptColdMove(harness, thread.id);
      expect(moved.outcome).toBe("moved");
    });
  });

  it("stopThreadForCurrentState holds a pin until the stop settles", async () => {
    await withTestHarness(async (harness) => {
      const { environment, ids, thread } = seedFixture(harness, "active");
      const stopping = stopThreadForCurrentState(
        harness.deps,
        thread,
        environment,
      );
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(getThreadHistoryPinCount(thread.id)).toBeGreaterThan(0);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });
      await stopping.catch(() => undefined);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("requestThreadStopForCurrentState on a cold thread is a no-op that leaves it cold", async () => {
    await withTestHarness(async (harness) => {
      const { environment, ids, thread } = seedFixture(harness, "idle");
      forceColdEligible(harness.db, ids);
      const moved = await attemptColdMove(harness, thread.id);
      expect(moved.outcome).toBe("moved");
      const before = getThread(harness.db, thread.id);
      const rowsBefore = countThreadEvents(harness.db, thread.id);
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      await sleep(10);
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(true);
      expect(countThreadEvents(harness.db, thread.id)).toBe(rowsBefore);
      expect(getThread(harness.db, thread.id)?.status).toBe(before?.status);
    });
  });

  it("interruptActiveThreadsForHost skips a cold thread and logs", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedFixture(harness, "active");
      forceColdStateRow(harness.db, thread.id);
      const logged = vi.spyOn(harness.deps.logger, "error");
      const result = interruptActiveThreadsForHost(harness.deps, {
        hostId: host.id,
        reason: "host-disconnected",
      } as never);
      expect(result.threads).toEqual([]);
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: thread.id }),
        "Cold thread selected for interruption; skipped",
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
      expect(environment.id).toBeTruthy();
    });
  });
});

const SEND_PAYLOAD = {
  input: textInput("hello"),
  mode: "start",
  model: "gpt-5",
  permissionMode: "full",
  reasoningLevel: "medium",
  serviceTier: "default",
} as const;

describe("cold tier writable-history pins on send and context clear", () => {
  it("rejects a stale unarchived Thread whose DB row is archived and cold", async () => {
    await withTestHarness(async (harness) => {
      const { environment, ids, thread } = seedFixture(harness);
      forceColdEligible(harness.db, ids);
      forceColdStateRow(harness.db, thread.id);
      const rowsBefore = countThreadEvents(harness.db, thread.id);
      const notify = vi.spyOn(harness.hub, "notifyThread");

      await expect(
        sendThreadMessage(harness.deps, {
          environment,
          payload: { ...SEND_PAYLOAD },
          thread,
          trigger: "user",
        }),
      ).rejects.toMatchObject({ body: { code: "thread_not_writable" } });
      await expect(
        clearThreadContext(harness.deps, { environment, thread }),
      ).rejects.toMatchObject({ status: 409 });

      expect(isThreadEventsCold(harness.db, thread.id)).toBe(true);
      expect(countThreadEvents(harness.db, thread.id)).toBe(rowsBefore);
      expect(notify).not.toHaveBeenCalled();
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("send keeps the pin while the start command is outstanding and releases on failure", async () => {
    await withTestHarness(async (harness) => {
      const { environment, ids, thread } = seedFixture(harness);
      harness.db.$client
        .prepare(
          "DELETE FROM events WHERE thread_id = ? AND type = 'thread/identity'",
        )
        .run(thread.id);
      const sending = sendThreadMessage(harness.deps, {
        environment,
        payload: { ...SEND_PAYLOAD },
        thread,
        trigger: "user",
      });
      const command = await waitForQueuedCommand(
        harness,
        ({ command: queued }) =>
          (queued as { threadId?: string }).threadId === thread.id,
      );
      expect(getThreadHistoryPinCount(thread.id)).toBeGreaterThan(0);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      await reportQueuedCommandError(harness, command, {
        errorCode: "test_failure",
        errorMessage: "Test failure",
      });
      await sending.catch(() => undefined);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });
});

function claimedQueuedRows(harness: TestAppHarness, threadId: string): number {
  return (
    harness.db.$client
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM queued_thread_messages WHERE thread_id = ? AND claimed_at IS NOT NULL")
      .get(threadId)?.count ?? 0
  );
}

function queuedRowCount(harness: TestAppHarness, threadId: string): number {
  return (
    harness.db.$client
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM queued_thread_messages WHERE thread_id = ?")
      .get(threadId)?.count ?? 0
  );
}

function seedQueuedFixture(harness: TestAppHarness) {
  const fixture = seedFixture(harness);
  harness.db.$client
    .prepare("DELETE FROM events WHERE thread_id = ?")
    .run(fixture.thread.id);
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: `provider-${fixture.thread.id}`,
    threadId: fixture.thread.id,
  });
  seedColdTierEvents(harness.db, fixture.thread.id, {
    identity: false,
    startSequence: 10,
  });
  const queued = seedQueuedMessage(harness.deps, {
    content: textInput("queued"),
    threadId: fixture.thread.id,
  });
  return { ...fixture, queued };
}

describe("cold tier queued-message roots", () => {
  afterEach(() => {
    setPluginHookProvider(undefined);
  });

  it("an explicit queued send to a cold thread raises thread_not_writable and claims nothing", async () => {
    await withTestHarness(async (harness) => {
      const { ids, queued, thread } = seedQueuedFixture(harness);
      forceColdEligible(harness.db, ids);
      forceColdStateRow(harness.db, thread.id);
      const rowsBefore = countThreadEvents(harness.db, thread.id);
      await expect(
        sendQueuedMessage(harness.deps, {
          claimPolicy: { kind: "explicit-send" },
          mode: "auto",
          queuedMessageId: queued.id,
          threadId: thread.id,
        }),
      ).rejects.toMatchObject({ body: { code: "thread_not_writable" } });
      expect(claimedQueuedRows(harness, thread.id)).toBe(0);
      expect(queuedRowCount(harness, thread.id)).toBe(1);
      expect(countThreadEvents(harness.db, thread.id)).toBe(rowsBefore);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("automatic dispatch leaves a cold thread's queued row unclaimed", async () => {
    await withTestHarness(async (harness) => {
      const { ids, queued, thread } = seedQueuedFixture(harness);
      forceColdEligible(harness.db, ids);
      forceColdStateRow(harness.db, thread.id);
      const rowsBefore = countThreadEvents(harness.db, thread.id);
      const notify = vi.spyOn(harness.hub, "notifyThread");
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: Date.now() + 60_000,
      });
      await sendQueuedMessage(harness.deps, {
        claimPolicy: {
          kind: "automatic",
          isGroupEligible: createAutomaticQueuedMessageGroupEligibility(
            harness.deps,
            { now: Date.now(), retryingFailure: false, thread },
          ),
          retryingFailure: false,
        },
        mode: "auto",
        queuedMessageId: queued.id,
        threadId: thread.id,
      }).catch(() => undefined);
      expect(claimedQueuedRows(harness, thread.id)).toBe(0);
      expect(queuedRowCount(harness, thread.id)).toBe(1);
      expect(countThreadEvents(harness.db, thread.id)).toBe(rowsBefore);
      expect(notify).not.toHaveBeenCalled();
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(true);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("a suspended automatic queued send refuses a move until it resumes", async () => {
    await withTestHarness(async (harness) => {
      const { ids, queued, thread } = seedQueuedFixture(harness);
      const entered = createDeferredPromise<void>();
      const gate = createDeferredPromise<void>();
      setPluginHookProvider({
        listHooks: (hook: string) =>
          hook === "message.dispatch"
            ? [
                {
                  pluginId: "suspender",
                  handler: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { action: "wait", reason: "held" } as const;
                  },
                },
              ]
            : [],
        invokeHook: (
          _pluginId: string,
          _label: string,
          run: Parameters<typeof invokePluginInline>[0],
        ) => invokePluginInline(run),
        decisionTimeoutMs: 10_000,
      } as never);
      const sending = sendQueuedMessage(harness.deps, {
        claimPolicy: {
          kind: "automatic",
          isGroupEligible: createAutomaticQueuedMessageGroupEligibility(
            harness.deps,
            { now: Date.now(), retryingFailure: false, thread },
          ),
          retryingFailure: false,
        },
        mode: "auto",
        queuedMessageId: queued.id,
        threadId: thread.id,
      });
      await entered.promise;
      expect(getThreadHistoryPinCount(thread.id)).toBeGreaterThan(0);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      gate.resolve();
      await sending;
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });
});
