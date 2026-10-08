import {
  archiveThread,
  createQueuedThreadMessage,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  listEvents,
  markThreadDeleted,
} from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { sendQueuedMessage } from "../../src/services/threads/queued-messages.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.restoreAllMocks();
});

type DuringHook = "archive" | "delete" | "cancel" | "proceed";

function seedReprovisionableParent(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-reprovision" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/reprovision-claim",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/reprovision-claim",
    status: "error",
    environmentProviderId: "personal-workspace",
    environmentProviderPluginId: "bb-plugin-environment-personal-workspace",
    isGitRepo: false,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-reprovision",
    threadId: thread.id,
  });
  return thread;
}

function requestedTurnCount(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  ).length;
}

describe("claimed system notice on a reprovisionable environment", () => {
  it.each<DuringHook>(["archive", "delete", "cancel", "proceed"])(
    "%s while the dispatch hook decides",
    async (duringHook) => {
      await withTestHarness(async (harness) => {
        const thread = seedReprovisionableParent(harness);
        const row = createQueuedThreadMessage(harness.db, harness.hub, {
          threadId: thread.id,
          content: textInput("claimed notice"),
          senderThreadId: null,
          model: "fake-model",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: { kind: "plugin", pluginId: "review", reason: "held" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: { kind: "child-completed", subject: null },
        });
        const requestedBefore = requestedTurnCount(harness, thread.id);
        setPluginHookProvider({
          listHooks: () => [
            {
              pluginId: "review",
              handler: () => {
                if (duringHook === "archive") {
                  archiveThread(harness.db, harness.hub, thread.id);
                } else if (duringHook === "delete") {
                  markThreadDeleted(harness.db, harness.hub, {
                    threadId: thread.id,
                  });
                } else if (duringHook === "cancel") {
                  deleteQueuedThreadMessage(harness.db, harness.hub, row.id);
                }
                return { action: "proceed" } as const;
              },
            },
          ],
          invokeHook: async (_pluginId, _label, run) => ({
            ok: true,
            value: await run(),
          }),
          decisionTimeoutMs: 10_000,
        });

        let failure: unknown = null;
        await sendQueuedMessage(harness.deps, {
          threadId: thread.id,
          queuedMessageId: row.id,
          mode: "auto",
          claimPolicy: {
            kind: "automatic",
            retryingFailure: false,
            isGroupEligible: () => true,
          },
        }).catch((error: unknown) => {
          failure = error;
        });

        const remaining = getQueuedThreadMessage(harness.db, row.id);
        if (duringHook === "proceed") {
          expect(failure).toBeNull();
          expect(remaining).toBeNull();
          expect(requestedTurnCount(harness, thread.id)).toBe(
            requestedBefore + 1,
          );
          expect(
            readThreadProvisionContext(harness.db, thread.id),
          ).not.toBeNull();
          return;
        }
        expect(failure).not.toBeNull();
        expect(requestedTurnCount(harness, thread.id)).toBe(requestedBefore);
        expect(readThreadProvisionContext(harness.db, thread.id)).toBeNull();
        if (duringHook === "cancel") {
          expect(remaining).toBeNull();
          return;
        }
        expect(remaining).not.toBeNull();
        expect(remaining?.claimedAt).toBeNull();
        expect(remaining?.claimToken).toBeNull();
      });
    },
    15_000,
  );
});
