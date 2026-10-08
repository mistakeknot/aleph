import { archiveThread, listQueuedThreadMessages } from "@bb/db";
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
import { withTestHarness } from "../helpers/test-app.js";

describe("recordQueuedMessageWait on a thread archived after its snapshot", () => {
  it("refuses with thread_not_writable and leaves no row", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-wait-fence" });
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
      archiveThread(harness.db, harness.hub, snapshot.id);

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
          details: { reason: "archived" },
        },
      });
      expect(listQueuedThreadMessages(harness.db, snapshot.id)).toEqual([]);
    });
  });
});
