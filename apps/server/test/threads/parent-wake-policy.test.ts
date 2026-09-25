import { and, eq } from "drizzle-orm";
import { events, listQueuedThreadMessages, threads } from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
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
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

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
  setPluginHookProvider(undefined);
  clearDeliveredChildOutputForTesting();
});

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
