import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortTransferOperation,
  createConnection,
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
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const userPayload = {
  mode: "auto",
  input: textInput("one post"),
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
} as const;

function requestCount(
  db: Parameters<typeof listEvents>[0],
  threadId: string,
): number {
  return listEvents(db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  ).length;
}

async function runColdCommitRedirectChange(options: {
  newDestinationRefuses: boolean;
}) {
  return withTestHarness(async (harness) => {
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
    const second = seedHostSession(harness.deps, { id: "second-host" });
    const secondEnvironment = seedEnvironment(harness.deps, {
      hostId: second.host.id,
      projectId: project.id,
      path: "/tmp/second",
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
    const secondTarget = make(secondEnvironment.id);
    harness.db.$client
      .prepare(
        "UPDATE threads SET status='pending', startup_context=? WHERE id=?",
      )
      .run(
        JSON.stringify({
          kind: "pending",
          environmentIntent: {
            type: "reuse",
            environmentId: firstTarget.environmentId,
          },
          fork: null,
          startedOnBehalfOf: null,
          titleProvided: false,
        }),
        firstTarget.id,
      );
    const first = retireQueuedThreadMessages(harness.db, {
      projectId: project.id,
      sourceThreadId: source.id,
      targetThreadId: firstTarget.id,
      operationKey: "first",
      retireEnabled: true,
      resolveWaitingOn: () => ({ kind: "thread-busy" }),
    });
    if (first.kind !== "retired") throw new Error("first retire failed");

    const file = join(mkdtempSync(join(tmpdir(), "cold-commit-")), "db.sqlite");
    writeFileSync(file, harness.db.$client.serialize());
    const held = createConnection(file);
    const other = createConnection(file);
    const original = harness.deps.db;
    harness.deps.db = held;
    const ids = [source.id, firstTarget.id, secondTarget.id];
    const before = Object.fromEntries(
      ids.map((id) => [id, requestCount(held, id)]),
    );
    const notify = harness.deps.hub.notifyThread.bind(harness.deps.hub);
    const state = { intervened: false, outsideTransaction: false };
    try {
      setPluginHookProvider({
        listHooks: (hook) =>
          hook === "message.dispatch"
            ? [
                {
                  pluginId: "holder",
                  handler: () => ({ action: "proceed" }),
                },
              ]
            : [],
        invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
        decisionTimeoutMs: 10_000,
      });
      harness.deps.hub.notifyThread = ((id, changes, ...rest) => {
        if (
          !state.intervened &&
          id === firstTarget.id &&
          changes.includes("status-changed") &&
          getThread(held, id)?.status === "starting"
        ) {
          state.intervened = true;
          state.outsideTransaction = !held.$client.inTransaction;
          const aborted = abortTransferOperation(other, {
            projectId: project.id,
            operationId: first.operationId,
            expectedRetirementOperationId: first.operationId,
            operationKey: "abort-first",
            resolveWaitingOn: () => ({ kind: "thread-busy" }),
          });
          expect(aborted.kind).toBe("aborted");
          const next = retireQueuedThreadMessages(other, {
            projectId: project.id,
            sourceThreadId: source.id,
            targetThreadId: secondTarget.id,
            operationKey: "second",
            retireEnabled: true,
            resolveWaitingOn: () => ({ kind: "thread-busy" }),
          });
          expect(next.kind).toBe("retired");
          if (options.newDestinationRefuses) {
            other.$client
              .prepare("UPDATE hosts SET phase='removing' WHERE id=?")
              .run(second.host.id);
          }
        }
        return notify(id, changes, ...rest);
      }) as typeof harness.deps.hub.notifyThread;
      const outcome = await acceptThreadSendRequest(harness.deps, {
        thread: getThread(held, source.id)!,
        payload: userPayload,
      }).then(
        (response) => ({ kind: "ok" as const, response }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      return {
        outcome,
        state,
        requests: Object.fromEntries(
          ids.map((id) => [id, requestCount(held, id) - before[id]!]),
        ),
        firstTargetStatus: getThread(held, firstTarget.id)?.status,
        queuedRows: ids.flatMap((id) => listQueuedThreadMessages(held, id)),
        ids: {
          source: source.id,
          firstTarget: firstTarget.id,
          secondTarget: secondTarget.id,
        },
      };
    } finally {
      harness.deps.hub.notifyThread = notify;
      harness.deps.db = original;
      held.$client.close();
      other.$client.close();
    }
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

describe("a cold admission whose redirect changes after it commits", () => {
  for (const newDestinationRefuses of [false, true]) {
    it(`finishes the committed admission once (new destination ${newDestinationRefuses ? "refuses" : "accepts"} work)`, async () => {
      const result = await runColdCommitRedirectChange({
        newDestinationRefuses,
      });
      expect(result.state).toEqual({
        intervened: true,
        outsideTransaction: true,
      });
      expect(result.outcome).toEqual({
        kind: "ok",
        response: { ok: true, delivery: "sent" },
      });
      expect(result.requests).toEqual({
        [result.ids.source]: 0,
        [result.ids.firstTarget]: 1,
        [result.ids.secondTarget]: 0,
      });
      expect(result.firstTargetStatus).toBe("starting");
      expect(result.queuedRows).toHaveLength(0);
    });
  }
});
