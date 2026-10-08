import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortTransferOperation,
  createConnection,
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

type Ingress = "user" | "parent";

const userPayload = {
  mode: "auto",
  input: textInput("late"),
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
} as const;

function seedThreads(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "first-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/first",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/first",
    status: "ready",
  });
  const make = (environmentId: string) => {
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId,
      status: "idle",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId,
      providerThreadId: `prov-${thread.id}`,
      threadId: thread.id,
    });
    return thread;
  };
  const source = make(environment.id);
  const firstTarget = make(environment.id);
  const second = seedHostSession(harness.deps, { id: "second-host" });
  const secondEnvironment = seedEnvironment(harness.deps, {
    hostId: second.host.id,
    projectId: project.id,
    path: "/tmp/second",
    status: "ready",
  });
  const secondTarget = make(secondEnvironment.id);
  return {
    project,
    source,
    firstTarget,
    secondTarget,
    secondHostId: second.host.id,
  };
}

async function runChangedRedirect(
  ingress: Ingress,
  options: { secondHostRemoving: boolean },
) {
  return withTestHarness(async (harness) => {
    const seeded = seedThreads(harness);
    const first = retireQueuedThreadMessages(harness.db, {
      projectId: seeded.project.id,
      sourceThreadId: seeded.source.id,
      targetThreadId: seeded.firstTarget.id,
      operationKey: "first",
      retireEnabled: true,
      resolveWaitingOn: () => ({ kind: "thread-busy" }),
    });
    if (first.kind !== "retired") throw new Error("first retire failed");

    const file = join(
      mkdtempSync(join(tmpdir(), "redirect-change-")),
      "db.sqlite",
    );
    writeFileSync(file, harness.db.$client.serialize());
    const held = createConnection(file);
    const other = createConnection(file);
    const original = harness.deps.db;
    harness.deps.db = held;
    const consulted: string[] = [];
    try {
      setPluginHookProvider({
        listHooks: (hook) =>
          hook === "message.dispatch"
            ? [
                {
                  pluginId: "holder",
                  handler: (context: { thread: { id: string } }) => {
                    consulted.push(context.thread.id);
                    if (context.thread.id === seeded.secondTarget.id) {
                      return { action: "wait", reason: "second approval" };
                    }
                    const aborted = abortTransferOperation(other, {
                      projectId: seeded.project.id,
                      operationId: first.operationId,
                      expectedRetirementOperationId: first.operationId,
                      operationKey: "abort-first",
                      resolveWaitingOn: () => ({ kind: "thread-busy" }),
                    });
                    expect(aborted.kind).toBe("aborted");
                    const next = retireQueuedThreadMessages(other, {
                      projectId: seeded.project.id,
                      sourceThreadId: seeded.source.id,
                      targetThreadId: seeded.secondTarget.id,
                      operationKey: "second",
                      retireEnabled: true,
                      resolveWaitingOn: () => ({ kind: "thread-busy" }),
                    });
                    expect(next.kind).toBe("retired");
                    if (options.secondHostRemoving) {
                      other.$client
                        .prepare("UPDATE hosts SET phase='removing' WHERE id=?")
                        .run(seeded.secondHostId);
                    }
                    return { action: "wait", reason: "first approval" };
                  },
                },
              ]
            : [],
        invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
        decisionTimeoutMs: 10_000,
      });
      const outcome =
        ingress === "user"
          ? await acceptThreadSendRequest(harness.deps, {
              thread: getThread(held, seeded.source.id)!,
              payload: userPayload,
            }).then(
              (response) => ({ kind: "ok" as const, response }),
              (error: unknown) => ({ kind: "error" as const, error }),
            )
          : await queueParentSystemMessage(harness.deps, {
              parentThreadId: seeded.source.id,
              input: textInput("late"),
              systemMessageKind: "child-completed",
              systemMessageSubject: null,
            }).then(
              (queued) => ({ kind: "ok" as const, response: queued }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );
      return {
        outcome,
        consulted,
        firstRows: listQueuedThreadMessages(held, seeded.firstTarget.id),
        secondRows: listQueuedThreadMessages(held, seeded.secondTarget.id),
        seeded,
      };
    } finally {
      harness.deps.db = original;
      held.$client.close();
      other.$client.close();
    }
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

describe("an arrival whose redirect changes while its dispatch hook runs", () => {
  for (const ingress of ["user", "parent"] as const) {
    it(`restarts admission against the new destination (${ingress})`, async () => {
      const result = await runChangedRedirect(ingress, {
        secondHostRemoving: false,
      });
      expect(result.outcome.kind).toBe("ok");
      expect(result.consulted).toEqual([
        result.seeded.firstTarget.id,
        result.seeded.secondTarget.id,
      ]);
      expect(result.firstRows).toHaveLength(0);
      expect(result.secondRows).toHaveLength(1);
      expect(JSON.parse(result.secondRows[0]!.waitingOn!)).toMatchObject({
        reason: "second approval",
      });
    });

    it(`refuses a destination whose host is being removed (${ingress})`, async () => {
      const result = await runChangedRedirect(ingress, {
        secondHostRemoving: true,
      });
      if (ingress === "user") {
        expect(result.outcome).toMatchObject({
          kind: "error",
          error: { body: { code: "machine_removing" } },
        });
      } else {
        expect(result.outcome).toEqual({ kind: "ok", response: false });
      }
      expect(result.firstRows).toHaveLength(0);
      expect(result.secondRows).toHaveLength(0);
    });
  }
});
