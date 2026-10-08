import {
  getThread,
  listQueuedThreadMessages,
  retireQueuedThreadMessages,
} from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { abortRetirement } from "../../src/services/threads/queued-messages.js";
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

function seedPair(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "held-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/held",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/held",
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

function retire(harness: TestAppHarness, pair: ReturnType<typeof seedPair>) {
  const result = retireQueuedThreadMessages(harness.db, {
    projectId: pair.project.id,
    sourceThreadId: pair.source.id,
    targetThreadId: pair.target.id,
    operationKey: "held",
    retireEnabled: true,
    resolveWaitingOn: () => ({ kind: "thread-busy" }),
  });
  if (result.kind !== "retired") throw new Error("retire did not succeed");
  return result;
}

function holdEveryDispatch() {
  setPluginHookProvider({
    listHooks: (hook) =>
      hook === "message.dispatch"
        ? [
            {
              pluginId: "holder",
              handler: () => ({ action: "wait", reason: "held" }),
            },
          ]
        : [],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
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

describe("a held arrival at a retired source", () => {
  it("is returned to the source when the retirement is aborted (user post)", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedPair(harness);
      const retired = retire(harness, pair);
      holdEveryDispatch();
      const response = await acceptThreadSendRequest(harness.deps, {
        thread: getThread(harness.db, pair.source.id)!,
        payload: userPayload,
      });
      expect(response.delivery).toBe("queued");
      expect(listQueuedThreadMessages(harness.db, pair.target.id)).toHaveLength(
        1,
      );
      const aborted = await abortRetirement(harness.deps, {
        operationId: retired.operationId,
        operationKey: "held-abort",
        expectedRetirementOperationId: retired.operationId,
      });
      expect(aborted.returned).toHaveLength(1);
      expect(aborted.residuals).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, pair.source.id)).toHaveLength(
        1,
      );
      expect(listQueuedThreadMessages(harness.db, pair.target.id)).toHaveLength(
        0,
      );
    });
  });

  it("is returned to the source when the retirement is aborted (parent notice)", async () => {
    await withTestHarness(async (harness) => {
      const pair = seedPair(harness);
      const retired = retire(harness, pair);
      holdEveryDispatch();
      expect(
        await queueParentSystemMessage(harness.deps, {
          parentThreadId: pair.source.id,
          input: textInput("notice"),
          systemMessageKind: "child-completed",
          systemMessageSubject: null,
        }),
      ).toBe(true);
      expect(listQueuedThreadMessages(harness.db, pair.target.id)).toHaveLength(
        1,
      );
      const aborted = await abortRetirement(harness.deps, {
        operationId: retired.operationId,
        operationKey: "held-abort",
        expectedRetirementOperationId: retired.operationId,
      });
      expect(aborted.returned).toHaveLength(1);
      expect(aborted.residuals).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, pair.source.id)).toHaveLength(
        1,
      );
      expect(listQueuedThreadMessages(harness.db, pair.target.id)).toHaveLength(
        0,
      );
    });
  });
});
