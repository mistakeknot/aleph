import {
  archiveThread,
  listQueuedThreadMessages,
  markThreadDeleted,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { recordQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

describe("recordQueuedMessageWait on a thread closed after its snapshot", () => {
  it.each([
    {
      reason: "archived",
      close: (harness: TestAppHarness, threadId: string) =>
        archiveThread(harness.db, harness.hub, threadId),
      expectedDetails: {
        reason: "archived",
        archivedAt: expect.any(Number),
        threadStatus: "idle",
      },
    },
    {
      reason: "deleted",
      close: (harness: TestAppHarness, threadId: string) =>
        markThreadDeleted(harness.db, harness.hub, { threadId }),
      expectedDetails: {
        reason: "deleted",
        archivedAt: null,
        threadStatus: "idle",
      },
    },
  ])(
    "refuses a $reason thread with thread_not_writable and leaves no row",
    async ({ close, expectedDetails }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wait-fence",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wait-fence",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wait-fence",
          status: "ready",
        });
        const snapshot = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        });
        close(harness, snapshot.id);

        let caught: unknown;
        try {
          recordQueuedMessageWait(harness.deps, {
            thread: snapshot,
            message: {
              input: textInput("late"),
              execution: {
                model: "gpt-5",
                reasoningLevel: "medium",
                permissionMode: "full",
                serviceTier: "default",
                source: "client/thread/start",
              },
              senderThreadId: null,
              origin: null,
              originPluginId: null,
              requestedBy: null,
              payload: { kind: "inline" },
              systemNotice: null,
              deliveryMode: "queue",
            },
            waitingOn: { kind: "thread-busy" },
            sendAt: null,
            claimed: null,
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ApiError);
        expect(caught).toMatchObject({
          status: 409,
          body: {
            code: "thread_not_writable",
            details: expectedDetails,
          },
        });
        expect(listQueuedThreadMessages(harness.db, snapshot.id)).toEqual([]);
      });
    },
  );
});

describe("Aleph queued wait creation", () => {
  it("keeps explicit queue intent through the fenced row creator", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "queue-intent-host",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/queue-intent",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queue-intent",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const entry = recordQueuedMessageWait(harness.deps, {
        thread,
        requestedThreadId: thread.id,
        message: {
          input: textInput("keep queued"),
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/thread/start",
          },
          senderThreadId: null,
          origin: null,
          originPluginId: null,
          requestedBy: null,
          payload: { kind: "inline" },
          systemNotice: null,
          deliveryMode: "queue",
        },
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        claimed: null,
      });
      expect(entry).not.toBeNull();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
        expect.objectContaining({ id: entry!.id, deliveryMode: "queue" }),
      ]);
    });
  });
});
