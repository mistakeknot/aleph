import {
  archiveThread,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  retireQueuedThreadMessages,
} from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

function seedRetirable(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "ingress-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/ingress",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/ingress",
    status: "ready",
  });
  const make = () => {
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "idle",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `prov-${thread.id}`,
      threadId: thread.id,
    });
    return thread;
  };
  return { project, source: make(), target: make() };
}

function retirePair(
  harness: TestAppHarness,
  pair: ReturnType<typeof seedRetirable>,
) {
  const result = retireQueuedThreadMessages(harness.db, {
    projectId: pair.project.id,
    sourceThreadId: pair.source.id,
    targetThreadId: pair.target.id,
    operationKey: "ingress",
    retireEnabled: true,
    resolveWaitingOn: () => ({ kind: "thread-busy" }),
  });
  expect(result.kind).toBe("retired");
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  ).length;
}

const userPayload = {
  mode: "auto",
  input: textInput("user"),
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
} as const;

afterEach(() => {
  setPluginHookProvider(undefined);
});

describe("retired source ingress", () => {
  it("sends a direct user message to the successor", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedRetirable(harness);
      retirePair(harness, pair);
      const sourceBefore = turnRequests(harness, pair.source.id);
      const targetBefore = turnRequests(harness, pair.target.id);
      await acceptThreadSendRequest(harness.deps, {
        thread: getThread(harness.db, pair.source.id)!,
        payload: userPayload,
      });
      expect(turnRequests(harness, pair.source.id)).toBe(sourceBefore);
      expect(turnRequests(harness, pair.target.id)).toBe(targetBefore + 1);
    });
  });

  it("refuses a direct user message in refuse mode", async () => {
    const previous = process.env.ALEPH_RETIRED_USER_POSTS;
    process.env.ALEPH_RETIRED_USER_POSTS = "refuse";
    try {
      await withTestHarness(async (harness) => {
        const pair = seedRetirable(harness);
        retirePair(harness, pair);
        const sourceBefore = turnRequests(harness, pair.source.id);
        await expect(
          acceptThreadSendRequest(harness.deps, {
            thread: getThread(harness.db, pair.source.id)!,
            payload: userPayload,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: {
            code: "thread_not_writable",
            details: { reason: "already_retired" },
          },
        });
        expect(turnRequests(harness, pair.source.id)).toBe(sourceBefore);
      });
    } finally {
      if (previous === undefined) delete process.env.ALEPH_RETIRED_USER_POSTS;
      else process.env.ALEPH_RETIRED_USER_POSTS = previous;
    }
  });

  it("delivers a parent notice for a retired source to the successor", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedRetirable(harness);
      retirePair(harness, pair);
      const sourceBefore = turnRequests(harness, pair.source.id);
      const targetBefore = turnRequests(harness, pair.target.id);
      expect(
        await queueParentSystemMessage(harness.deps, {
          parentThreadId: pair.source.id,
          input: textInput("notice"),
          systemMessageKind: "child-completed",
          systemMessageSubject: null,
        }),
      ).toBe(true);
      expect(turnRequests(harness, pair.source.id)).toBe(sourceBefore);
      expect(turnRequests(harness, pair.target.id)).toBe(targetBefore + 1);
    });
  });

  it("delivers a parent notice for an archived retired source to the successor", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedRetirable(harness);
      retirePair(harness, pair);
      archiveThread(harness.db, harness.hub, pair.source.id);
      const targetBefore = turnRequests(harness, pair.target.id);
      expect(
        await queueParentSystemMessage(harness.deps, {
          parentThreadId: pair.source.id,
          input: textInput("notice"),
          systemMessageKind: "child-completed",
          systemMessageSubject: null,
        }),
      ).toBe(true);
      expect(turnRequests(harness, pair.target.id)).toBe(targetBefore + 1);
    });
  });

  it("queues an explicit message for an archived retired source on the successor", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedRetirable(harness);
      retirePair(harness, pair);
      archiveThread(harness.db, harness.hub, pair.source.id);
      const response = await harness.app.request(
        `/api/v1/threads/${pair.source.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(userPayload),
        },
      );
      expect(response.status).toBe(201);
      expect(listQueuedThreadMessages(harness.db, pair.target.id)).toHaveLength(
        1,
      );
      expect(listQueuedThreadMessages(harness.db, pair.source.id)).toHaveLength(
        0,
      );
    });
  });

  it("redirects a direct user message when the source retires during a dispatch hook", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedRetirable(harness);
      let retired = false;
      setPluginHookProvider({
        listHooks: (hook) =>
          hook === "message.dispatch"
            ? [
                {
                  pluginId: "retirer",
                  handler: () => {
                    if (!retired) {
                      retired = true;
                      retirePair(harness, pair);
                    }
                    return { action: "proceed" };
                  },
                },
              ]
            : [],
        invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
        decisionTimeoutMs: 10_000,
      });
      const sourceBefore = turnRequests(harness, pair.source.id);
      const targetBefore = turnRequests(harness, pair.target.id);
      await acceptThreadSendRequest(harness.deps, {
        thread: getThread(harness.db, pair.source.id)!,
        payload: userPayload,
      });
      expect(turnRequests(harness, pair.source.id)).toBe(sourceBefore);
      expect(turnRequests(harness, pair.target.id)).toBe(targetBefore + 1);
    });
  });
});
