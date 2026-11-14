import { deliverDetachedToolResult } from "../../src/services/plugins/detached-tool-result-delivery.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import {
  getQueuedThreadMessage,
  deleteQueuedThreadMessage,
  listEvents,
  listQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
} from "@bb/db";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  turnRequestEventDataSchema,
  turnScope,
  type PromptInput,
  type TurnRequestEventData,
} from "@bb/domain";
import type {
  MessageDispatchHookContext,
  PluginHookName,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  createQueuedMessageForThread,
  releaseStaleQueuedMessageDispatchClaims,
  sendNextQueuedMessageIfPresent,
  transferQueuedMessage,
} from "../../src/services/threads/queued-messages.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { buildTurnFailedEvent } from "../../src/services/threads/turn-failed.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedEvent,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/dispatcher-paths-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installDispatchHook(
  handler: (
    context: MessageDispatchHookContext,
  ) =>
    | { action: "proceed" }
    | { action: "wait"; reason: string }
    | Promise<{ action: "proceed" }>,
): void {
  const registry: HookRegistry = {
    "message.dispatch": [{ pluginId: "dispatcher-paths-test", handler }],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

function seedRunnableThread(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active"; title?: string },
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: args.hostId,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: args.status,
    ...(args.title !== undefined ? { title: args.title } : {}),
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  if (args.status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: `turn-${args.hostId}`,
      providerThreadId: `provider-${args.hostId}`,
    });
  }
  return { environment, host, project, session, thread };
}

function turnRequests(
  harness: TestAppHarness,
  threadId: string,
): TurnRequestEventData[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function queuedRows(harness: TestAppHarness, threadId: string) {
  return listQueuedThreadMessages(harness.db, threadId).map(
    toThreadQueuedMessage,
  );
}

function firstText(request: TurnRequestEventData | undefined): string {
  const first = request?.input[0];
  return first?.type === "text" ? first.text : "";
}

describe("first message of a pending thread", () => {
  it("keeps the sender thread that started it", async () => {
    await withTestHarness(async (harness) => {
      installDispatchHook(() => ({ action: "wait", reason: "Not yet" }));
      const { host, project } = seedRunnableThread(harness, {
        hostId: "host-pending-sender",
        status: "idle",
      });
      const sender = seedThread(harness.deps, {
        projectId: project.id,
        title: "Sender",
      });
      const pending = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: WORKSPACE_PATH },
        },
        input: textInput("Created first"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });
      expect(pending.status).toBe("pending");
      setPluginHookProvider(undefined);

      await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("Please review the plan"),
          mode: "auto",
          senderThreadId: sender.id,
        },
        thread: pending,
      });

      const [request] = turnRequests(harness, pending.id);
      expect(request).toMatchObject({
        initiator: "agent",
        senderThreadId: sender.id,
      });
      expect(firstText(request)).toContain(sender.id);
      expect(firstText(request)).toContain("Please review the plan");
    });
  });
});

describe("the plugin that sent a turn", () => {
  function failedTurnSender(harness: TestAppHarness, threadId: string) {
    applyLoggedThreadLifecycleEvent(harness.deps, {
      event: { type: "run.failed" },
      threadId,
    });
    return buildTurnFailedEvent(harness.db, threadId)?.originPluginId;
  }

  it("is recorded on an inline send and reported when the turn fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-plugin-inline",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("Run the check"),
          mode: "steer-if-active",
          originPluginId: "automations",
        },
        thread,
      });

      expect(turnRequests(harness, thread.id).at(-1)?.originPluginId).toBe(
        "automations",
      );
      expect(failedTurnSender(harness, thread.id)).toBe("automations");
    });
  });

  it("survives the queue when the message is released later", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-plugin-queued",
        status: "idle",
      });
      const sendAt = Date.now() + 60_000;
      const response = await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("Later"),
          mode: "auto",
          originPluginId: "automations",
          sendAt,
        },
        thread,
      });
      expect(response.delivery).toBe("queued");

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });

      expect(firstText(turnRequests(harness, thread.id).at(-1))).toBe("Later");
      expect(failedTurnSender(harness, thread.id)).toBe("automations");
    });
  });

  it("survives a transfer to another thread of the project", async () => {
    await withTestHarness(async (harness) => {
      const {
        environment,
        project,
        thread: source,
      } = seedRunnableThread(harness, {
        hostId: "host-plugin-transfer",
        status: "idle",
      });
      const target = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-host-plugin-transfer-target",
        threadId: target.id,
      });
      const sendAt = Date.now() + 60_000;
      const response = await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("Moved"),
          mode: "auto",
          originPluginId: "automations",
          sendAt,
        },
        thread: source,
      });
      expect(response.delivery).toBe("queued");
      const [row] = queuedRows(harness, source.id);

      await transferQueuedMessage(harness.deps, {
        queuedMessageId: row!.id,
        sourceThread: source,
        targetThread: target,
      });
      expect(queuedRows(harness, target.id)).toHaveLength(1);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });

      expect(firstText(turnRequests(harness, target.id).at(-1))).toBe("Moved");
      expect(failedTurnSender(harness, target.id)).toBe("automations");
    });
  });

  it("is recorded on the first turn of a thread a plugin spawns", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedRunnableThread(harness, {
        hostId: "host-plugin-spawn",
        status: "idle",
      });
      const spawned = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: WORKSPACE_PATH },
        },
        input: textInput("First run"),
        origin: "plugin",
        originPluginId: "automations",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(turnRequests(harness, spawned.id)).toEqual([
        expect.objectContaining({ originPluginId: "automations" }),
      ]);
    });
  });

  it("is null for a message nobody sent through a plugin", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-plugin-user",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("By hand"), mode: "auto" },
        thread,
      });

      expect(
        turnRequests(harness, thread.id).at(-1)?.originPluginId,
      ).toBeUndefined();
      expect(failedTurnSender(harness, thread.id)).toBeNull();
    });
  });
});

describe("queued delivery mode", () => {
  it.each([
    { mode: "queue-if-active", steers: false },
    { mode: "steer", steers: true },
  ] as const)(
    "a $mode message that comes due during a running turn steers: $steers",
    async ({ mode, steers }) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedRunnableThread(harness, {
          hostId: `host-due-${mode}`,
          status: "active",
        });
        const sendAt = Date.now() + 60_000;
        const response = await acceptThreadSendRequest(harness.deps, {
          payload: {
            input: textInput("Later"),
            mode,
            sendAt,
            wakeCause: "message",
            wakeRef: "scheduled-1",
          },
          thread,
        });
        expect(response).toMatchObject({
          delivery: "queued",
          queuedMessage: {
            waitingOn: { kind: "time" },
            wakeCause: "message",
            wakeRef: "scheduled-1",
          },
        });

        await runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now: sendAt + 1,
        });

        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(steers ? 1 : 0);
        expect(queuedRows(harness, thread.id)).toEqual(
          steers
            ? []
            : [expect.objectContaining({ waitingOn: { kind: "thread-busy" } })],
        );
      });
    },
  );
});

const CLEAR_INPUT: PromptInput[] = [
  {
    type: "text",
    text: "/clear",
    mentions: [
      {
        start: 0,
        end: "/clear".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "clear",
          source: "command",
          origin: "builtin",
          label: "clear",
          argumentHint: null,
        },
      },
    ],
  },
];

function contextClearCount(harness: TestAppHarness, threadId: string): number {
  return listEvents(harness.db, { threadId }).filter(
    (event) =>
      event.type === "system/operation" &&
      JSON.parse(event.data).operation === THREAD_CONTEXT_CLEAR_OPERATION,
  ).length;
}

function respondToHost(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedRunnableThread>,
) {
  return registerHostRpcResponder(harness, {
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    handle: async ({ command }) => ({
      ok: true,
      result:
        command.type === "thread.stop"
          ? { providerCheckpointId: null }
          : command.type === "host.read_workspace_agent_context"
            ? EMPTY_WORKSPACE_AGENT_CONTEXT
            : { trace: { spans: [] } },
    }),
  });
}

describe("queued context clear", () => {
  it("consumes a queued /clear row so claim recovery cannot run it again", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedRunnableThread(harness, {
        hostId: "host-queued-clear",
        status: "idle",
      });
      respondToHost(harness, fixture);
      const queued = await createQueuedMessageForThread(harness.deps, {
        thread: fixture.thread,
        payload: { input: CLEAR_INPUT },
      });

      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: fixture.thread.id,
      });
      releaseStaleQueuedMessageDispatchClaims(
        harness.deps,
        Date.now() + 60 * 60 * 1000,
      );
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: fixture.thread.id,
      });

      expect(getQueuedThreadMessage(harness.db, queued.id)).toBeNull();
      expect(contextClearCount(harness, fixture.thread.id)).toBe(1);
    });
  });
});

describe("delivery mode intent", () => {
  it("keeps queue mode for a message sent while only background work runs", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedRunnableThread(harness, {
        hostId: "host-background-queue",
        status: "active",
      });
      const mainRun = (sequence: number, state: "idle" | "running") =>
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-host-background-queue",
          sequence,
          type: "turn/mainRun/updated",
          scope: turnScope("turn-host-background-queue"),
          data: { state },
        });
      mainRun(10, "idle");
      const sendAt = Date.now() + 60_000;
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("Later"), mode: "queue-if-active", sendAt },
        thread,
      });
      mainRun(11, "running");

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });

      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(queuedRows(harness, thread.id)).toEqual([
        expect.objectContaining({ waitingOn: { kind: "thread-busy" } }),
      ]);
    });
  });

  it.each([
    ["steer", "queue-if-active"],
    ["queue-if-active", "steer"],
  ] as const)(
    "waits for the running turn with a group of a %s row and a %s row",
    async (...modes) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedRunnableThread(harness, {
          hostId: `host-mixed-group-${modes[0]}`,
          status: "active",
        });
        const sendAt = Date.now() + 60_000;
        for (const mode of modes) {
          await acceptThreadSendRequest(harness.deps, {
            payload: { input: textInput(mode), mode, sendAt },
            thread,
          });
        }
        const rows = listQueuedThreadMessages(harness.db, thread.id);
        expect(
          setQueuedThreadMessageGroupBoundary({
            db: harness.db,
            notifier: harness.hub,
            threadId: thread.id,
            expectedGroupedPrefixQueuedMessageIds: rows.map((row) => row.id),
            groupBoundaryQueuedMessageId: rows[1]!.id,
          }).kind,
        ).toBe("updated");

        await runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now: sendAt + 1,
        });

        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(0);
        expect(queuedRows(harness, thread.id)).toEqual([
          expect.objectContaining({ waitingOn: { kind: "thread-busy" } }),
          expect.objectContaining({ waitingOn: { kind: "thread-busy" } }),
        ]);
      });
    },
  );
});

describe("queue intent after the dispatch hook", () => {
  it("keeps a queue-mode row waiting when the main run resumes during the hook", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedRunnableThread(harness, {
        hostId: "host-resume-during-hook",
        status: "active",
      });
      const mainRun = (sequence: number, state: "idle" | "running") =>
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-host-resume-during-hook",
          sequence,
          type: "turn/mainRun/updated",
          scope: turnScope("turn-host-resume-during-hook"),
          data: { state },
        });
      mainRun(10, "idle");
      const sendAt = Date.now() + 60_000;
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("Later"), mode: "queue-if-active", sendAt },
        thread,
      });
      installDispatchHook(async () => {
        mainRun(11, "running");
        return { action: "proceed" };
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });

      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(queuedRows(harness, thread.id)).toEqual([
        expect.objectContaining({ waitingOn: { kind: "thread-busy" } }),
      ]);
    });
  });
});

describe("wake request attribution", () => {
  it("preserves two distinct steers without replacing their request IDs", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-wake-steers",
        status: "active",
      });
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("first"),
          mode: "steer",
          wakeCause: "card_pick",
          wakeRef: "pick-1",
        },
      });
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("second"),
          mode: "steer",
          wakeCause: "message",
          wakeRef: "note-2",
        },
      });
      const requests = turnRequests(harness, thread.id).slice(-2);
      expect(requests).toMatchObject([
        { wakeCause: "card_pick", wakeRef: "pick-1" },
        { wakeCause: "message", wakeRef: "note-2" },
      ]);
      expect(new Set(requests.map((request) => request.requestId)).size).toBe(
        2,
      );
      for (const request of requests) expect(request.target.kind).toBe("steer");
    });
  });
  it("does not turn scheduled delivery into a timer cause", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-wake-scheduled",
        status: "idle",
      });
      const requestsBefore = turnRequests(harness, thread.id);
      const sendAt = Date.now() + 60_000;
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("later"),
          mode: "auto",
          sendAt,
          wakeCause: "message",
          wakeRef: "note-1",
        },
      });
      expect(turnRequests(harness, thread.id)).toEqual(requestsBefore);
      expect(queuedRows(harness, thread.id)[0]).toMatchObject({
        wakeCause: "message",
        wakeRef: "note-1",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });
      expect(turnRequests(harness, thread.id).at(-1)).toMatchObject({
        wakeCause: "message",
        wakeRef: "note-1",
      });
    });
  });
});

describe("queued wake lifecycle", () => {
  it("retains each mixed input source when a group dispatches", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-wake-group",
        status: "idle",
      });
      const sendAt = Date.now() + 60_000;
      for (const wakeCause of ["message", "timer"] as const) {
        await acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            input: textInput(wakeCause),
            mode: "auto",
            sendAt,
            wakeCause,
            wakeRef: wakeCause,
          },
        });
      }
      const rows = listQueuedThreadMessages(harness.db, thread.id);
      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: rows.map((row) => row.id),
          groupBoundaryQueuedMessageId: rows[1]!.id,
        }).kind,
      ).toBe("updated");
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });
      expect(turnRequests(harness, thread.id).at(-1)).toMatchObject({
        wakeCause: "unknown",
        wakeSources: [
          { wakeCause: "message", wakeRef: "message" },
          { wakeCause: "timer", wakeRef: "timer" },
        ],
        wakeRef: "message",
      });
    });
  });
  it("does not create a turn for a canceled attributed row", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-wake-canceled",
        status: "idle",
      });
      const requestsBefore = turnRequests(harness, thread.id);
      const sendAt = Date.now() + 60_000;
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("cancel"),
          mode: "auto",
          sendAt,
          wakeCause: "card_pick",
        },
      });
      const row = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      deleteQueuedThreadMessage(harness.db, harness.hub, row.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });
      expect(turnRequests(harness, thread.id)).toEqual(requestsBefore);
    });
  });
});

it("retains first-start attribution while the pending thread waits", async () => {
  await withTestHarness(async (harness) => {
    installDispatchHook(() => ({ action: "wait", reason: "Not yet" }));
    const { host, project } = seedRunnableThread(harness, {
      hostId: "host-wake-pending",
      status: "idle",
    });
    const pending = await createThreadFromRequest(harness.deps, {
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: WORKSPACE_PATH },
      },
      input: textInput("First task"),
      origin: "sdk",
      projectId: project.id,
      providerId: "codex",
      startedOnBehalfOf: null,
      wakeCause: "workflow",
      wakeRef: "work-1",
    });
    expect(pending.status).toBe("pending");
    expect(queuedRows(harness, pending.id)[0]).toMatchObject({
      wakeCause: "workflow",
      wakeRef: "work-1",
    });
    setPluginHookProvider(undefined);
    await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
    expect(turnRequests(harness, pending.id).at(-1)).toMatchObject({
      wakeCause: "workflow",
      wakeRef: "work-1",
    });
  });
});

it.each(["idle", "active"] as const)(
  "preserves immediate send attribution for a %s thread",
  async (status) => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: `host-wake-${status}`,
        status,
      });
      const response = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("Task"),
          mode: "queue-if-active",
          wakeCause: "review",
          wakeRef: "review-1",
        },
      });
      if (status === "active") {
        expect(response).toMatchObject({
          delivery: "queued",
          queuedMessage: { wakeCause: "review", wakeRef: "review-1" },
        });
      } else {
        expect(response.delivery).toBe("sent");
        expect(turnRequests(harness, thread.id).at(-1)).toMatchObject({
          wakeCause: "review",
          wakeRef: "review-1",
        });
      }
    });
  },
);

it.each([
  "message",
  "timer",
  "workflow",
  "review",
  "merge",
  "interaction",
  "retry",
  undefined,
] as const)(
  "preserves producer %s through queue admission, polling and dispatch",
  async (wakeCause) => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "producer-dispatch",
        status: "idle",
      });
      const sendAt = Date.now() + 60_000;
      const wakeRef = "operation-1";
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("Continue"),
          mode: "auto",
          sendAt,
          wakeCause,
          wakeRef,
        },
      });
      expect(queuedRows(harness, thread.id)[0]).toMatchObject({
        wakeCause: wakeCause ?? "unknown",
        wakeRef,
      });
      const before = turnRequests(harness, thread.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt - 1,
      });
      expect(turnRequests(harness, thread.id)).toEqual(before);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 1,
      });
      expect(turnRequests(harness, thread.id).at(-1)).toMatchObject({
        wakeCause: wakeCause ?? "unknown",
        wakeRef,
      });
      const after = turnRequests(harness, thread.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt + 2,
      });
      expect(turnRequests(harness, thread.id)).toEqual(after);
    });
  },
);

it.each([
  ["tool-result-delivered", "interaction"],
  ["environment-directory-updated", "message"],
  ["unlabeled", "unknown"],
] as const)(
  "tags typed %s notices through dispatch",
  async (systemMessageKind, wakeCause) => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "typed-notice",
        status: "idle",
      });
      await queueParentSystemMessage(harness.deps, {
        parentThreadId: thread.id,
        input: textInput("Continue"),
        systemMessageKind,
        systemMessageSubject: null,
        wakeRef: "event-1",
      });
      expect(turnRequests(harness, thread.id).at(-1)).toMatchObject({
        wakeCause,
        wakeRef: "event-1",
      });
    });
  },
);

it.each(["call-short", "x".repeat(200), "x".repeat(201), "call-".repeat(100)])(
  "delivers detached results with bounded stable provider references (%#)",
  async (callId) => {
    const refs: (string | null)[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await withTestHarness(async (harness) => {
        const { thread } = seedRunnableThread(harness, {
          hostId: "bounded-ref",
          status: "idle",
        });
        await deliverDetachedToolResult(harness.deps, {
          threadId: thread.id,
          wakeRef: callId,
          toolName: "test-tool",
          presentation: null,
          response: {
            success: true,
            contentItems: [{ type: "inputText", text: "Complete" }],
          },
        });
        const request = turnRequests(harness, thread.id).at(-1)!;
        expect(request.wakeCause).toBe("interaction");
        expect(request.wakeRef).toBeTypeOf("string");
        expect(request.wakeRef!.length).toBeLessThanOrEqual(200);
        if (callId.length <= 200) expect(request.wakeRef).toBe(callId);
        refs.push(request.wakeRef);
      });
    }
    expect(refs[0]).toBe(refs[1]);
  },
);
