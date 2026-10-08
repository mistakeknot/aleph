import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortTransferOperation,
  createConnection,
  getThread,
  listEvents,
  retireQueuedThreadMessages,
  type DbConnection,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

type Window = "before-environment" | "during-stop";

const clearInput = [
  {
    type: "text",
    text: "/clear",
    mentions: [
      {
        start: 0,
        end: 6,
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
] as never;

function clearMarkers(db: DbConnection, threadId: string) {
  return listEvents(db, { threadId }).filter(
    (event) => event.type === "system/operation",
  );
}

async function runClearRedirectChange(window: Window) {
  return withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps, {
      id: "clear-host",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/clear",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: "/tmp/clear",
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
    const source = make();
    const firstTarget = make();
    const secondTarget = make();
    const first = retireQueuedThreadMessages(harness.db, {
      projectId: project.id,
      sourceThreadId: source.id,
      targetThreadId: firstTarget.id,
      operationKey: "first",
      retireEnabled: true,
      resolveWaitingOn: () => ({ kind: "thread-busy" }),
    });
    if (first.kind !== "retired") throw new Error("first retire failed");

    const file = join(
      mkdtempSync(join(tmpdir(), "clear-redirect-change-")),
      "db.sqlite",
    );
    writeFileSync(file, harness.db.$client.serialize());
    const held = createConnection(file);
    const other = createConnection(file);
    const original = harness.deps.db;
    harness.deps.db = held;
    const state = { changed: false, stops: 0 };
    const changeRedirect = () => {
      if (state.changed) return;
      state.changed = true;
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
    };
    const responder = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: () => {
        state.stops += 1;
        if (window === "during-stop") changeRedirect();
        return { ok: true, result: { providerCheckpointId: null } };
      },
    });
    try {
      const flight = acceptThreadSendRequest(harness.deps, {
        thread: getThread(held, source.id)!,
        payload: {
          input: clearInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        } as never,
      });
      if (window === "before-environment") changeRedirect();
      const response = await flight;
      return {
        response,
        state,
        markers: {
          source: clearMarkers(held, source.id),
          firstTarget: clearMarkers(held, firstTarget.id),
          secondTarget: clearMarkers(held, secondTarget.id),
        },
      };
    } finally {
      responder.unregister();
      harness.deps.db = original;
      held.$client.close();
      other.$client.close();
    }
  });
}

describe("a standalone clear whose redirect changes before its marker commits", () => {
  for (const window of ["before-environment", "during-stop"] as const) {
    it(`marks only the current destination (${window})`, async () => {
      const result = await runClearRedirectChange(window);
      expect(result.state.changed).toBe(true);
      expect(result.response).toEqual({ ok: true, delivery: "sent" });
      expect(result.markers.source).toHaveLength(0);
      expect(result.markers.firstTarget).toHaveLength(0);
      expect(result.markers.secondTarget).toHaveLength(1);
    });
  }
});
