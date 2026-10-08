import { and, eq } from "drizzle-orm";
import {
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  events,
  getQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  listRunningThreads,
  threads,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadQueuedMessageSchema,
  turnRequestEventDataSchema,
} from "@bb/domain";
import type { ThreadQueuedMessage } from "@bb/domain";
import {
  createQueuedMessageRequestSchema,
  threadQueuedMessageListResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import { clearDeliveredChildOutputForTesting } from "../../src/services/threads/parent-wake-policy.js";
import {
  createAutomaticQueuedMessageGroupEligibility,
  sendQueuedMessage,
} from "../../src/services/threads/queued-messages.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  expireArchiveUndoGrace,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";
import { readJson } from "../helpers/json.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

type HookRegistry = { [K in PluginHookName]: PluginHookRegistration<K>[] };

function emptyRegistry(): HookRegistry {
  return { "message.dispatch": [] };
}

function installHooks(registry: HookRegistry): void {
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
  setPluginHookProvider(undefined);
  clearDeliveredChildOutputForTesting();
});

function recordQueuedEvents(): ThreadQueuedMessage[] {
  const queuedEvents: ThreadQueuedMessage[] = [];
  setPluginThreadEventEmitter({
    emitThreadEvents: () => {},
    emitTerminalInput: () => {},
    emitHostDeleted: () => {},
    emitThreadCreated: () => {},
    emitThreadActive: () => {},
    emitThreadIdle: () => {},
    emitThreadFailed: () => {},
    emitThreadArchived: () => {},
    emitThreadDeleted: () => {},
    emitInteractionPending: () => {},
    emitMessageQueued: (entry) => queuedEvents.push(entry),
    emitMessageDispatched: () => {},
    emitMessageCancelled: () => {},
    emitThreadUnarchived: () => {},
    emitTurnFailed: () => {},
  });
  return queuedEvents;
}

interface ParentFixture {
  environmentId: string;
  parentThreadId: string;
  projectId: string;
}

function seedParentFixture(
  harness: TestHarness,
  hostId: string,
): ParentFixture {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${hostId}-environment`,
  });
  const parent = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    title: "Manager",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    inputText: "Manage things",
    model: "fake-model",
  });
  return {
    environmentId: environment.id,
    parentThreadId: parent.id,
    projectId: project.id,
  };
}

function seedChildFinalOutput(
  harness: TestHarness,
  args: { childThreadId: string; turnId: string; text: string },
): void {
  const sequence = nextSequence(harness, args.childThreadId);
  harness.deps.db
    .insert(events)
    .values({
      id: `evt_${args.childThreadId}_output_${sequence}`,
      threadId: args.childThreadId,
      environmentId: null,
      providerThreadId: "provider-child",
      scopeKind: "turn",
      turnId: args.turnId,
      itemId: "msg-1",
      itemKind: "agentMessage",
      parentToolCallId: null,
      type: "item/completed",
      data: JSON.stringify({
        threadId: args.childThreadId,
        providerThreadId: "provider-child",
        item: { type: "agentMessage", id: "msg-1", text: args.text },
      }),
      sequence,
      createdAt: Date.now(),
    })
    .run();
}

function seedChildTurnCompleted(
  harness: TestHarness,
  args: { childThreadId: string; turnId: string },
): void {
  seedChildTurnCompletedWithStatus(harness, { ...args, status: "completed" });
}

function seedChildTurnCompletedWithStatus(
  harness: TestHarness,
  args: {
    childThreadId: string;
    turnId: string;
    status: "completed" | "failed" | "interrupted";
  },
): void {
  const sequence = nextSequence(harness, args.childThreadId);
  harness.deps.db
    .insert(events)
    .values({
      id: `evt_${args.childThreadId}_completed_${args.turnId}`,
      threadId: args.childThreadId,
      environmentId: null,
      providerThreadId: "provider-child",
      scopeKind: "turn",
      turnId: args.turnId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      type: "turn/completed",
      data: JSON.stringify({
        providerThreadId: "provider-child",
        status: args.status,
      }),
      sequence,
      createdAt: Date.now(),
    })
    .run();
}

function nextSequence(harness: TestHarness, threadId: string): number {
  const rows = harness.db
    .select({ sequence: events.sequence })
    .from(events)
    .where(eq(events.threadId, threadId))
    .all();
  return rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
}

function seedChildTurnRequest(
  harness: TestHarness,
  args: {
    childThreadId: string;
    turnId: string;
    initiator: "user" | "agent" | "system";
    senderThreadId: string | null;
  },
): void {
  const request = appendClientTurnEvent(harness.deps, {
    threadId: args.childThreadId,
    environmentId: null,
    type: "client/turn/requested",
    input: [{ type: "text", text: "continue", mentions: [] }],
    target: { kind: "new-turn" },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    initiator: args.initiator,
    senderThreadId: args.senderThreadId,
    requestMethod: "turn/start",
    source: "tell",
  });
  harness.deps.db
    .insert(events)
    .values({
      id: `evt_${args.childThreadId}_accepted_${args.turnId}`,
      threadId: args.childThreadId,
      environmentId: null,
      providerThreadId: "provider-child",
      scopeKind: "turn",
      turnId: args.turnId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      type: "turn/input/accepted",
      data: JSON.stringify({
        providerThreadId: "provider-child",
        clientRequestId: request.requestId,
      }),
      sequence: nextSequence(harness, args.childThreadId),
      createdAt: Date.now(),
    })
    .run();
}

async function waitForParentTurnRequests(
  harness: TestHarness,
  parentThreadId: string,
  minCount: number,
  timeoutMs = 4_000,
): Promise<{ initiator: string; systemMessageKind: string | undefined }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = harness.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.threadId, parentThreadId),
          eq(events.type, "client/turn/requested"),
        ),
      )
      .orderBy(events.sequence)
      .all();
    const systemRows = rows
      .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
      .filter((data) => data.initiator === "system");
    if (systemRows.length >= minCount) {
      return systemRows.map((data) => ({
        initiator: data.initiator,
        systemMessageKind: data.systemMessageKind,
      }));
    }
    if (Date.now() > deadline) {
      return systemRows.map((data) => ({
        initiator: data.initiator,
        systemMessageKind: data.systemMessageKind,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForQueuedParentNotice(
  harness: TestHarness,
  parentThreadId: string,
  timeoutMs = 6_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = listQueuedThreadMessages(harness.db, parentThreadId);
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error("parent notice was never queued");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForSecondWakeSignal(
  harness: TestHarness,
  parentThreadId: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stamped = await waitForParentTurnRequests(
      harness,
      parentThreadId,
      2,
      200,
    );
    if (stamped.length >= 2) {
      return true;
    }
    const queued = listQueuedThreadMessages(harness.db, parentThreadId);
    const wokeViaQueue = queued.some((message) => {
      const notice =
        typeof message.systemNotice === "string"
          ? JSON.parse(message.systemNotice)
          : message.systemNotice;
      if (notice?.kind !== "child-completed") {
        return false;
      }
      const waitingOn =
        typeof message.waitingOn === "string"
          ? JSON.parse(message.waitingOn)
          : message.waitingOn;
      return waitingOn?.kind !== "plugin" && waitingOn?.kind !== "interaction";
    });
    if (wokeViaQueue) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("parent wake policy", () => {
  it("wakes the parent for a normal user-driven child completion", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-normal");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "First result",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });

      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
      );
      expect(stamped).toHaveLength(1);
    });
  });

  it("suppresses a duplicate final message from a self-initiated child continuation", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-dup");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Same result",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      // No client request row for turn-2, so it is self-initiated (compaction
      // or rotation), and it restates the exact text already delivered.
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-2",
        text: "Same result",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-2",
        turnStatus: "completed",
      });

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
        200,
      );
      expect(stamped).toHaveLength(1);
    });
  }, 10_000);

  it("R1: always wakes on a duplicate final message from a parent-requested turn", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-parent-dup");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "system",
        senderThreadId: fixture.parentThreadId,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "DONE",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      // The manager (parent) asks the child to do task B. The child ends
      // that turn with the exact same "DONE" text. This turn was requested
      // by the parent, so it must always wake, duplicate text or not.
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-2",
        initiator: "system",
        senderThreadId: fixture.parentThreadId,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-2",
        text: "DONE",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-2",
        turnStatus: "completed",
      });

      const wokeAgain = await waitForSecondWakeSignal(
        harness,
        fixture.parentThreadId,
      );
      expect(wokeAgain).toBe(true);
    });
  }, 20_000);

  it("R1: always wakes a user-requested turn even without a new agent message this turn", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-user-no-new-msg");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "BLOCKED: waiting on X",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      // The user follows up. The child's second turn ends without a new
      // agent message (tool calls only) -- getThreadTurnOutput reports null
      // for this turn, not the previous turn's stale text. Still a
      // user-requested turn, so it must still wake.
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-2",
        initiator: "user",
        senderThreadId: null,
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-2",
        turnStatus: "completed",
      });

      const wokeAgain = await waitForSecondWakeSignal(
        harness,
        fixture.parentThreadId,
      );
      expect(wokeAgain).toBe(true);
    });
  }, 20_000);

  it("suppresses a self-initiated child continuation that produced no new output", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-self");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildTurnCompleted(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-no-request",
        turnStatus: "completed",
      });

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
        200,
      );
      expect(stamped).toHaveLength(1);
    });
  }, 10_000);

  it("still wakes a self-initiated child continuation that produced genuinely new output", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-self-new");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Already reported",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-no-request",
        text: "Something new after compaction",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-no-request",
        turnStatus: "completed",
      });

      const wokeAgain = await waitForSecondWakeSignal(
        harness,
        fixture.parentThreadId,
      );
      expect(wokeAgain).toBe(true);
    });
  }, 20_000);

  it("suppresses a grandchild-notice cascade the child never asked to forward", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-cascade");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      const grandchild = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Sub-worker",
        parentThreadId: child.id,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Already reported",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-cascade",
        initiator: "system",
        senderThreadId: grandchild.id,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-cascade",
        text: "Same result restated",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-cascade",
        turnStatus: "completed",
      });

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
        200,
      );
      expect(stamped).toHaveLength(1);
    });
  }, 10_000);

  it("still wakes on an error even when self-initiated", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-self-error");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-no-request",
        turnStatus: "failed",
      });

      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
      );
      expect(stamped).toHaveLength(1);
      expect(stamped[0]?.systemMessageKind).toBe("child-failed");
    });
  });

  it("never wakes a held parent thread directly, and records the notice durably", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () => ({ action: "wait", reason: "quota exceeded" }) as const,
      });
      installHooks(registry);

      const fixture = seedParentFixture(harness, "host-held");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Held result",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
        200,
      );
      expect(stamped).toHaveLength(0);

      const queued = listQueuedThreadMessages(
        harness.db,
        fixture.parentThreadId,
      );
      expect(queued).toHaveLength(1);
      const waitingOn =
        typeof queued[0]?.waitingOn === "string"
          ? JSON.parse(queued[0].waitingOn)
          : queued[0]?.waitingOn;
      expect(waitingOn).toEqual({
        kind: "plugin",
        pluginId: "quota-governor",
        reason: "quota exceeded",
      });
      const systemNotice =
        typeof queued[0]?.systemNotice === "string"
          ? JSON.parse(queued[0].systemNotice)
          : queued[0]?.systemNotice;
      expect(systemNotice?.kind).toBe("child-completed");
    });
  }, 10_000);

  it("R4: the first held child notice announces message.queued without any recheck", async () => {
    await withTestHarness(async (harness) => {
      const queuedEvents = recordQueuedEvents();
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () => ({ action: "wait", reason: "quota exceeded" }) as const,
      });
      installHooks(registry);

      const fixture = seedParentFixture(harness, "host-r4-queued-event");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Held result",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      const held = await waitForQueuedParentNotice(
        harness,
        fixture.parentThreadId,
      );

      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0]).toMatchObject({
        id: held.id,
        threadId: fixture.parentThreadId,
        waitingOn: {
          kind: "plugin",
          pluginId: "quota-governor",
          reason: "quota exceeded",
        },
        systemNotice: { kind: "child-completed" },
      });
    });
  }, 10_000);

  it("R4: a held system notice goes back through message.dispatch as system on every recheck, and releases once the hook proceeds", async () => {
    await withTestHarness(async (harness) => {
      const seen: { initiator: string; queuedMessageCount: number }[] = [];
      let decision: "wait" | "proceed" = "wait";
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: (context) => {
          seen.push({
            initiator: context.initiator,
            queuedMessageCount: context.queuedMessages.length,
          });
          return decision === "wait"
            ? ({ action: "wait", reason: "quota exceeded" } as const)
            : ({ action: "proceed" } as const);
        },
      });
      installHooks(registry);

      const fixture = seedParentFixture(harness, "host-r4-recheck");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Held result",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      const held = await waitForQueuedParentNotice(
        harness,
        fixture.parentThreadId,
      );
      expect(seen.at(0)).toEqual({
        initiator: "system",
        queuedMessageCount: 0,
      });

      const passesBeforeRecheck = seen.length;
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(seen.slice(passesBeforeRecheck)).toEqual([
        { initiator: "system", queuedMessageCount: 1 },
      ]);
      const stillHeld = listQueuedThreadMessages(
        harness.db,
        fixture.parentThreadId,
      );
      expect(stillHeld.map((row) => row.id)).toEqual([held.id]);
      expect(
        await waitForParentTurnRequests(
          harness,
          fixture.parentThreadId,
          1,
          200,
        ),
      ).toHaveLength(0);

      decision = "proceed";
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(seen.at(-1)?.initiator).toBe("system");
      expect(
        listQueuedThreadMessages(harness.db, fixture.parentThreadId),
      ).toHaveLength(0);
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
      );
      expect(stamped).toEqual([
        { initiator: "system", systemMessageKind: "child-completed" },
      ]);
    });
  }, 15_000);

  it("R2: a throwing message.dispatch hook queues the notice durably instead of dropping it", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "flaky-plugin",
        handler: () => {
          throw new Error("boom");
        },
      });
      installHooks(registry);

      const fixture = seedParentFixture(harness, "host-hook-throws");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });
      seedChildTurnRequest(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        initiator: "user",
        senderThreadId: null,
      });
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "Result despite a broken hook",
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
        200,
      );
      expect(stamped).toHaveLength(0);

      const queued = listQueuedThreadMessages(
        harness.db,
        fixture.parentThreadId,
      );
      expect(queued).toHaveLength(1);
      const waitingOn =
        typeof queued[0]?.waitingOn === "string"
          ? JSON.parse(queued[0].waitingOn)
          : queued[0]?.waitingOn;
      expect(waitingOn?.kind).toBe("plugin");
      const systemNotice =
        typeof queued[0]?.systemNotice === "string"
          ? JSON.parse(queued[0].systemNotice)
          : queued[0]?.systemNotice;
      expect(systemNotice?.kind).toBe("child-completed");
    });
  }, 10_000);

  it("P2-1: does not mark output as delivered when queuing the notice never runs", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-not-delivered");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      // Archive the parent thread up front so queueParentSystemMessage is a
      // no-op (returns false without delivering or queuing anything).
      harness.deps.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, fixture.parentThreadId))
        .run();

      // Self-initiated (no client request row), so duplicate suppression
      // would apply if -- wrongly -- this output got marked as delivered.
      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        text: "DONE",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(
        listQueuedThreadMessages(harness.db, fixture.parentThreadId),
      ).toHaveLength(0);

      harness.deps.db
        .update(threads)
        .set({ archivedAt: null })
        .where(eq(threads.id, fixture.parentThreadId))
        .run();

      seedChildFinalOutput(harness, {
        childThreadId: child.id,
        turnId: "turn-2",
        text: "DONE",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-2",
        turnStatus: "completed",
      });

      const stamped = await waitForParentTurnRequests(
        harness,
        fixture.parentThreadId,
        1,
      );
      expect(stamped).toHaveLength(1);
    });
  }, 10_000);

  it("P2-2: a failed first turn does not count as the child's completed first turn", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-failed-first-turn");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      // The child's first-ever turn fails, with no client request row (a
      // hidden delegated child dispatched directly into it).
      seedChildTurnCompletedWithStatus(harness, {
        childThreadId: child.id,
        turnId: "turn-1",
        status: "failed",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-1",
        turnStatus: "failed",
      });
      await waitForParentTurnRequests(harness, fixture.parentThreadId, 1);

      // The retry is the child's first *completed* turn, and it produces no
      // new agent message this turn (finalText is null for turn-2). It
      // still has no client request row. If the earlier failed turn wrongly
      // counted as a completed prior turn, this retry would be treated as
      // self-initiated and, with no new text, suppressed. Because the
      // earlier turn failed rather than completing, this one must still
      // count as the child's first completion -- never self-initiated --
      // and wake the parent regardless.
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnId: "turn-2",
        turnStatus: "completed",
      });

      const wokeAgain = await waitForSecondWakeSignal(
        harness,
        fixture.parentThreadId,
      );
      expect(wokeAgain).toBe(true);
    });
  }, 20_000);
});

describe("queued system notice transfer (R4 retirement forward, R6)", () => {
  const HELD_UNTIL = Date.now() + 3_600_000;

  function seedSuccessorThread(
    harness: TestHarness,
    fixture: ParentFixture,
    hostId: string,
  ): string {
    const successor = seedThread(harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      title: "Successor",
    });
    seedThreadRuntimeState(harness.deps, {
      threadId: successor.id,
      environmentId: fixture.environmentId,
      providerThreadId: `provider-${hostId}-successor`,
      inputText: "Take over",
      model: "fake-model",
    });
    return successor.id;
  }

  async function holdChildCompletionNotice(
    harness: TestHarness,
    fixture: ParentFixture,
  ) {
    const child = seedThread(harness.deps, {
      projectId: fixture.projectId,
      title: "Worker",
      parentThreadId: fixture.parentThreadId,
    });
    seedChildTurnRequest(harness, {
      childThreadId: child.id,
      turnId: "turn-1",
      initiator: "user",
      senderThreadId: null,
    });
    seedChildFinalOutput(harness, {
      childThreadId: child.id,
      turnId: "turn-1",
      text: "Held result",
    });
    await queueChildThreadTurnNotificationBestEffort(harness.deps, {
      childThread: child,
      parentThreadId: fixture.parentThreadId,
      turnId: "turn-1",
      turnStatus: "completed",
    });
    return waitForQueuedParentNotice(harness, fixture.parentThreadId);
  }

  async function listQueuedOverHttp(harness: TestHarness, threadId: string) {
    const response = await harness.app.request(
      `/api/v1/threads/${threadId}/queued-messages`,
    );
    expect(response.status).toBe(200);
    return threadQueuedMessageListResponseSchema.parse(
      await readJson(response),
    );
  }

  it("reads systemNotice and waitingOn, and a transfer keeps systemNotice, waitingOn and sendAt", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () =>
          ({
            action: "wait",
            reason: "quota exceeded",
            sendAt: HELD_UNTIL,
          }) as const,
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r6-transfer");
      const successorId = seedSuccessorThread(
        harness,
        fixture,
        "host-r6-transfer",
      );
      const held = await holdChildCompletionNotice(harness, fixture);

      const [read] = await listQueuedOverHttp(harness, fixture.parentThreadId);
      expect(read).toMatchObject({
        id: held.id,
        initiator: "system",
        sendAt: HELD_UNTIL,
        systemNotice: { kind: "child-completed" },
        waitingOn: {
          kind: "plugin",
          pluginId: "quota-governor",
          reason: "quota exceeded",
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetThreadId: successorId }),
        },
      );
      expect(response.status).toBe(201);
      const moved = threadQueuedMessageSchema.parse(await readJson(response));
      expect(moved).toMatchObject({
        threadId: successorId,
        initiator: "system",
        sendAt: HELD_UNTIL,
        systemNotice: read!.systemNotice,
        waitingOn: read!.waitingOn,
        content: read!.content,
      });
      expect(moved.id).not.toBe(held.id);
      expect(await listQueuedOverHttp(harness, fixture.parentThreadId)).toEqual(
        [],
      );
      expect(await listQueuedOverHttp(harness, successorId)).toEqual([moved]);
    });
  }, 20_000);

  it("a transferred held notice announces message.queued for its new row", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () =>
          ({
            action: "wait",
            reason: "quota exceeded",
            sendAt: HELD_UNTIL,
          }) as const,
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r4-transfer-event");
      const successorId = seedSuccessorThread(
        harness,
        fixture,
        "host-r4-transfer-event",
      );
      const held = await holdChildCompletionNotice(harness, fixture);
      const queuedEvents = recordQueuedEvents();
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetThreadId: successorId }),
        },
      );
      expect(response.status).toBe(201);
      const moved = threadQueuedMessageSchema.parse(await readJson(response));
      expect(queuedEvents.map((entry) => entry.id)).toEqual([moved.id]);
      expect(queuedEvents[0]).toMatchObject({
        threadId: successorId,
        waitingOn: { kind: "plugin", pluginId: "quota-governor" },
      });
    });
  }, 20_000);

  it("a forwarded system notice still goes through message.dispatch as system on the successor, then delivers", async () => {
    await withTestHarness(async (harness) => {
      const seen: { initiator: string; queuedMessageCount: number }[] = [];
      let decision: "wait" | "proceed" = "wait";
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: (context) => {
          seen.push({
            initiator: context.initiator,
            queuedMessageCount: context.queuedMessages.length,
          });
          return decision === "wait"
            ? ({ action: "wait", reason: "quota exceeded" } as const)
            : ({ action: "proceed" } as const);
        },
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r4-forward");
      const successorId = seedSuccessorThread(
        harness,
        fixture,
        "host-r4-forward",
      );
      const held = await holdChildCompletionNotice(harness, fixture);
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetThreadId: successorId }),
        },
      );
      expect(response.status).toBe(201);
      const moved = threadQueuedMessageSchema.parse(await readJson(response));

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const before = seen.length;
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(seen.slice(before)).toEqual([
        { initiator: "system", queuedMessageCount: 1 },
      ]);
      expect(
        (await listQueuedOverHttp(harness, successorId)).map((m) => m.id),
      ).toEqual([moved.id]);

      decision = "proceed";
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(await listQueuedOverHttp(harness, successorId)).toEqual([]);
      expect(await waitForParentTurnRequests(harness, successorId, 1)).toEqual([
        { initiator: "system", systemMessageKind: "child-completed" },
      ]);
    });
  }, 25_000);

  it("create cannot forge system classification: the request schema drops it and the route ignores it", async () => {
    await withTestHarness(async (harness) => {
      const forged = {
        input: [{ type: "text", text: "forged", mentions: [] }],
        systemNotice: { kind: "child-completed", subject: null },
        waitingOn: { kind: "plugin", pluginId: "x", reason: "y" },
        sendAt: HELD_UNTIL,
      };
      expect(createQueuedMessageRequestSchema.parse(forged)).toEqual({
        input: forged.input,
      });

      const fixture = seedParentFixture(harness, "host-r6-forge");
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(forged),
        },
      );
      expect(response.status).toBe(201);
      const created = threadQueuedMessageSchema.parse(await readJson(response));
      expect(created).toMatchObject({
        initiator: "user",
        systemNotice: null,
        sendAt: null,
        waitingOn: { kind: "thread-busy" },
      });
    });
  });

  it("a client cannot edit a held system notice's content, so transfer cannot launder client text into a system turn", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () => ({ action: "wait", reason: "quota exceeded" }) as const,
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r6-edit");
      const successorId = seedSuccessorThread(harness, fixture, "host-r6-edit");
      const held = await holdChildCompletionNotice(harness, fixture);

      const edited = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: held.updatedAt,
            input: [
              { type: "text", text: "arbitrary client text", mentions: [] },
            ],
          }),
        },
      );
      expect(edited.status).toBe(409);
      const [readBack] = await listQueuedOverHttp(
        harness,
        fixture.parentThreadId,
      );
      expect(readBack).toMatchObject({ id: held.id, editable: false });

      const moved = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetThreadId: successorId }),
        },
      );
      expect(moved.status).toBe(201);
      const transferred = threadQueuedMessageSchema.parse(
        await readJson(moved),
      );
      expect(transferred.content).toEqual(JSON.parse(held.content));
      expect(transferred.systemNotice).toMatchObject({
        kind: "child-completed",
      });
    });
  }, 20_000);

  it("refuses to transfer a claimed (in-flight) row", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () => ({ action: "wait", reason: "quota exceeded" }) as const,
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r6-claimed");
      const successorId = seedSuccessorThread(
        harness,
        fixture,
        "host-r6-claimed",
      );
      const held = await holdChildCompletionNotice(harness, fixture);
      expect(
        claimQueuedThreadMessage(harness.db, harness.deps.hub, held.id),
      ).not.toBeNull();

      const moved = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetThreadId: successorId }),
        },
      );
      expect(moved.status).toBe(409);
      expect(
        (await listQueuedOverHttp(harness, successorId)).map((m) => m.id),
      ).toEqual([]);
    });
  }, 20_000);

  it("refuses to transfer across projects or to the same thread", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: () => ({ action: "wait", reason: "quota exceeded" }) as const,
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-r6-refuse");
      const other = seedParentFixture(harness, "host-r6-refuse-other");
      const held = await holdChildCompletionNotice(harness, fixture);
      const transfer = (targetThreadId: string) =>
        harness.app.request(
          `/api/v1/threads/${fixture.parentThreadId}/queued-messages/${held.id}/transfer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ targetThreadId }),
          },
        );
      expect((await transfer(other.parentThreadId)).status).toBe(400);
      expect((await transfer(fixture.parentThreadId)).status).toBe(400);
      expect(
        (await listQueuedOverHttp(harness, fixture.parentThreadId)).map(
          (m) => m.id,
        ),
      ).toEqual([held.id]);
    });
  }, 20_000);
});

describe("transfer-all queued messages (retirement forward)", () => {
  const SEND_AT = Date.now() + 3_600_000;

  function seedSuccessor(harness: TestHarness, fixture: ParentFixture) {
    const successor = seedThread(harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      title: "Successor",
    });
    seedThreadRuntimeState(harness.deps, {
      threadId: successor.id,
      environmentId: fixture.environmentId,
      providerThreadId: `provider-successor-${successor.id}`,
      inputText: "Take over",
      model: "fake-model",
    });
    return successor.id;
  }

  function seedRow(
    harness: TestHarness,
    threadId: string,
    text: string,
    overrides: Partial<Parameters<typeof createQueuedThreadMessage>[2]> = {},
  ) {
    return createQueuedThreadMessage(harness.db, harness.deps.hub, {
      threadId,
      content: [{ type: "text", text, mentions: [] }],
      senderThreadId: null,
      origin: null,
      originPluginId: null,
      model: "fake-model",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
      ...overrides,
    });
  }

  function transferAll(
    harness: TestHarness,
    sourceId: string,
    targetThreadId: string,
  ) {
    return harness.app.request(
      `/api/v1/threads/${sourceId}/queued-messages/transfer-all`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetThreadId }),
      },
    );
  }

  async function listOverHttp(harness: TestHarness, threadId: string) {
    const response = await harness.app.request(
      `/api/v1/threads/${threadId}/queued-messages`,
    );
    return threadQueuedMessageListResponseSchema.parse(
      await readJson(response),
    );
  }

  it("moves every movable row in order, keeps classification and waits, reports skips, and is idempotent", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-ta-main");
      const source = fixture.parentThreadId;
      const target = seedSuccessor(harness, fixture);
      seedRow(harness, target, "already on target");
      const plain = seedRow(harness, source, "plain");
      const notice = seedRow(harness, source, "notice", {
        waitingOn: { kind: "plugin", pluginId: "limiter", reason: "held" },
        sendAt: SEND_AT,
        systemNotice: { kind: "child-completed", subject: null },
      });
      const timed = seedRow(harness, source, "timed", {
        waitingOn: { kind: "time" },
        sendAt: SEND_AT,
      });
      const claimed = seedRow(harness, source, "claimed");
      expect(
        claimQueuedThreadMessage(harness.db, harness.deps.hub, claimed.id),
      ).not.toBeNull();
      const retry = seedRow(harness, source, "retry", {
        payload: {
          kind: "retry",
          retryOfTurnRequestId: encodeClientTurnRequestIdNumber({ value: 7 }),
          attempt: 2,
          reason: "Rate limited",
        },
      });

      const response = await transferAll(harness, source, target);
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as {
        moved: { id: string; newId: string }[];
        skipped: { id: string; reason: string }[];
      };
      expect(body.moved.map((m) => m.id)).toEqual([
        plain.id,
        notice.id,
        timed.id,
      ]);
      expect(body.skipped).toEqual([
        { id: claimed.id, reason: "claimed" },
        { id: retry.id, reason: "not_inline" },
      ]);

      const onTarget = await listOverHttp(harness, target);
      expect(onTarget.map((m) => m.id)).toEqual([
        expect.any(String),
        ...body.moved.map((m) => m.newId),
      ]);
      const [, movedPlain, movedNotice, movedTimed] = onTarget;
      expect(movedPlain).toMatchObject({
        initiator: "user",
        systemNotice: null,
        sendAt: null,
        waitingOn: { kind: "thread-busy" },
      });
      expect(movedNotice).toMatchObject({
        initiator: "system",
        systemNotice: { kind: "child-completed" },
        sendAt: SEND_AT,
        waitingOn: { kind: "plugin", pluginId: "limiter", reason: "held" },
        editable: false,
      });
      expect(movedTimed).toMatchObject({
        sendAt: SEND_AT,
        waitingOn: { kind: "time" },
      });
      expect((await listOverHttp(harness, source)).map((m) => m.id)).toEqual([
        retry.id,
      ]);
      expect(getQueuedThreadMessage(harness.db, claimed.id)?.threadId).toBe(
        source,
      );

      const again = await transferAll(harness, source, target);
      expect(again.status).toBe(200);
      const second = (await readJson(again)) as { moved: unknown[] };
      expect(second.moved).toEqual([]);
      expect(await listOverHttp(harness, target)).toEqual(onTarget);
    });
  }, 25_000);

  it("announces message.queued only for moved rows that land held", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-r4-all-event");
      const targetId = seedSuccessor(harness, fixture);
      seedRow(harness, fixture.parentThreadId, "plain");
      seedRow(harness, fixture.parentThreadId, "held", {
        waitingOn: { kind: "plugin", pluginId: "quota-governor", reason: "q" },
        sendAt: SEND_AT,
      });
      const queuedEvents = recordQueuedEvents();
      const response = await transferAll(
        harness,
        fixture.parentThreadId,
        targetId,
      );
      expect(response.status).toBe(200);
      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0]).toMatchObject({
        threadId: targetId,
        waitingOn: { kind: "plugin", pluginId: "quota-governor" },
      });
    });
  }, 20_000);

  it("refuses cross-project, same-thread, archived and missing targets and moves nothing", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-ta-refuse");
      const other = seedParentFixture(harness, "host-ta-refuse-other");
      const source = fixture.parentThreadId;
      const row = seedRow(harness, source, "stays");
      const archived = seedSuccessor(harness, fixture);
      expireArchiveUndoGrace(harness.deps, archived);

      expect(
        (await transferAll(harness, source, other.parentThreadId)).status,
      ).toBe(400);
      expect((await transferAll(harness, source, source)).status).toBe(400);
      expect(
        (await transferAll(harness, source, archived)).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await transferAll(harness, source, "thr_missing")).status).toBe(
        404,
      );
      expect((await listOverHttp(harness, source)).map((m) => m.id)).toEqual([
        row.id,
      ]);
    });
  }, 25_000);

  it("a forwarded system notice still passes through message.dispatch as system on the target, and the request cannot set classification", async () => {
    await withTestHarness(async (harness) => {
      const seen: string[] = [];
      let decision: "wait" | "proceed" = "wait";
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "quota-governor",
        handler: (context) => {
          seen.push(context.initiator);
          return decision === "wait"
            ? ({ action: "wait", reason: "quota exceeded" } as const)
            : ({ action: "proceed" } as const);
        },
      });
      installHooks(registry);
      const fixture = seedParentFixture(harness, "host-ta-hook");
      const target = seedSuccessor(harness, fixture);
      const notice = seedRow(harness, fixture.parentThreadId, "notice", {
        waitingOn: {
          kind: "plugin",
          pluginId: "quota-governor",
          reason: "quota exceeded",
        },
        systemNotice: { kind: "child-completed", subject: null },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages/transfer-all`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetThreadId: target,
            systemNotice: { kind: "child-completed", subject: null },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as {
        moved: { id: string; newId: string }[];
      };
      expect(body.moved.map((m) => m.id)).toEqual([notice.id]);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const before = seen.length;
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(seen.slice(before)).toEqual(["system"]);

      decision = "proceed";
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(await listOverHttp(harness, target)).toEqual([]);
      expect(await waitForParentTurnRequests(harness, target, 1)).toEqual([
        { initiator: "system", systemMessageKind: "child-completed" },
      ]);
    });
  }, 25_000);

  it("a plain user row without a classification cannot become a system turn through transfer-all", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-ta-forge");
      const target = seedSuccessor(harness, fixture);
      const forged = await harness.app.request(
        `/api/v1/threads/${fixture.parentThreadId}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "forged", mentions: [] }],
            systemNotice: { kind: "child-completed", subject: null },
          }),
        },
      );
      expect(forged.status).toBe(201);
      expect(
        (await transferAll(harness, fixture.parentThreadId, target)).status,
      ).toBe(200);
      const [moved] = await listOverHttp(harness, target);
      expect(moved).toMatchObject({ initiator: "user", systemNotice: null });
    });
  }, 25_000);
});

describe("held system notice drain: admission and cancellation", () => {
  function seedHeldNotice(harness: TestHarness, fixture: ParentFixture) {
    return createQueuedThreadMessage(harness.db, harness.deps.hub, {
      threadId: fixture.parentThreadId,
      content: [{ type: "text", text: "notice", mentions: [] }],
      senderThreadId: null,
      origin: null,
      originPluginId: null,
      model: "fake-model",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "plugin", pluginId: "limiter", reason: "held" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: { kind: "child-completed", subject: null },
    });
  }

  function drain(harness: TestHarness, row: ReturnType<typeof seedHeldNotice>) {
    return sendQueuedMessage(harness.deps, {
      threadId: row.threadId,
      queuedMessageId: row.id,
      mode: "auto",
      claimPolicy: {
        kind: "automatic",
        retryingFailure: false,
        isGroupEligible: createAutomaticQueuedMessageGroupEligibility(
          harness.deps,
          {
            now: Date.now(),
            retryingFailure: false,
            thread: getThread(harness.db, row.threadId)!,
          },
        ),
      },
    });
  }

  it("commits the notice's admission before the evaluation lock releases, so a concurrency limit of one holds", async () => {
    await withTestHarness(async (harness) => {
      const rows = ["host-adm-a", "host-adm-b"].map((hostId) =>
        seedHeldNotice(harness, seedParentFixture(harness, hostId)),
      );
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () =>
          listRunningThreads(harness.db).length === 0
            ? ({ action: "proceed" } as const)
            : ({ action: "wait", reason: "capacity" } as const),
      });
      installHooks(registry);

      await Promise.all(rows.map((row) => drain(harness, row)));

      expect(listRunningThreads(harness.db)).toHaveLength(1);
      const stillQueued = rows.filter(
        (row) =>
          listQueuedThreadMessages(harness.db, row.threadId).length === 1,
      );
      expect(stillQueued).toHaveLength(1);
    });
  }, 20_000);

  it("a row deleted over HTTP while the hook decides produces no turn", async () => {
    await withTestHarness(async (harness) => {
      const row = seedHeldNotice(
        harness,
        seedParentFixture(harness, "host-cancel"),
      );
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: async () => {
          const response = await harness.app.request(
            `/api/v1/threads/${row.threadId}/queued-messages/${row.id}`,
            { method: "DELETE" },
          );
          expect(response.status).toBe(200);
          return { action: "proceed" } as const;
        },
      });
      installHooks(registry);

      await drain(harness, row).catch(() => undefined);

      expect(
        await waitForParentTurnRequests(harness, row.threadId, 1, 300),
      ).toEqual([]);
      expect(getThread(harness.db, row.threadId)?.status).not.toBe("active");
      expect(listQueuedThreadMessages(harness.db, row.threadId)).toEqual([]);
    });
  }, 20_000);
});
