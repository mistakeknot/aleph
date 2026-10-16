import {
  archiveThread,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  markThreadDeleted,
} from "@bb/db";
import type { EnvironmentRow } from "@bb/db";
import type { Thread } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.restoreAllMocks();
});

type Landing = "archive" | "delete";

const landings: readonly Landing[] = ["archive", "delete"];

interface Fixture {
  environment: EnvironmentRow;
  thread: Thread;
}

interface SeedFixtureArgs {
  environmentStatus?: "ready" | "error";
  harness: TestAppHarness;
  status: "active" | "idle";
  value: number;
  withActiveTurn?: boolean;
}

function seedFixture(args: SeedFixtureArgs): Fixture {
  const { host } = seedHostSession(args.harness.deps, {
    id: `host-revalidation-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/revalidation-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/revalidation-${args.value}`,
    status: args.environmentStatus ?? "ready",
    ...(args.environmentStatus === "error"
      ? {
          environmentProviderId: "personal-workspace",
          environmentProviderPluginId:
            "bb-plugin-environment-personal-workspace",
          isGitRepo: false,
        }
      : {}),
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: args.status,
  });
  seedThreadRuntimeState(args.harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-revalidation-${args.value}`,
    threadId: thread.id,
  });
  if (args.withActiveTurn === true) {
    seedTurnStarted(args.harness.deps, {
      environmentId: environment.id,
      providerThreadId: `provider-revalidation-${args.value}`,
      threadId: thread.id,
      turnId: `turn-revalidation-${args.value}`,
    });
  }
  return { environment, thread };
}

function land(harness: TestAppHarness, threadId: string, landing: Landing) {
  if (landing === "archive") {
    archiveThread(harness.db, harness.hub, threadId);
    return;
  }
  markThreadDeleted(harness.db, harness.hub, { threadId });
}

async function deliverWithLandingDuringHook(
  harness: TestAppHarness,
  threadId: string,
  landing: Landing,
  decision: { action: "proceed" } | { action: "wait"; reason: string },
): Promise<boolean> {
  let release: () => void = () => {};
  const latch = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hookEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    hookEntered = resolve;
  });
  setPluginHookProvider({
    listHooks: () => [
      {
        pluginId: "holder",
        handler: async () => {
          hookEntered();
          await latch;
          return decision;
        },
      },
    ],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  const delivered = queueParentSystemMessage(harness.deps, {
    input: textInput("child finished behind a hook"),
    parentThreadId: threadId,
    systemMessageKind: "child-completed",
    systemMessageSubject: null,
  });
  await entered;
  land(harness, threadId, landing);
  release();
  return delivered;
}

function requestedTurns(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

describe.each(landings)(
  "post-hook revalidation, %s lands after the hook",
  (landing) => {
    it("refuses the ready-parent direct delivery", async () => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFixture({ harness, status: "idle", value: 1 });
        const requestedBefore = requestedTurns(harness, thread.id).length;

        await expect(
          deliverWithLandingDuringHook(harness, thread.id, landing, {
            action: "proceed",
          }),
        ).resolves.toBe(false);

        expect(requestedTurns(harness, thread.id)).toHaveLength(
          requestedBefore,
        );
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
    });

    it("refuses the reprovision delivery", async () => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFixture({
          environmentStatus: "error",
          harness,
          status: "idle",
          value: 2,
        });
        const requestedBefore = requestedTurns(harness, thread.id).length;

        await expect(
          deliverWithLandingDuringHook(harness, thread.id, landing, {
            action: "proceed",
          }),
        ).resolves.toBe(false);

        expect(requestedTurns(harness, thread.id)).toHaveLength(
          requestedBefore,
        );
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(readThreadProvisionContext(harness.db, thread.id)).toBeNull();
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
    });

    it("refuses the active-parent direct delivery", async () => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFixture({
          harness,
          status: "active",
          value: 3,
          withActiveTurn: true,
        });
        const requestedBefore = requestedTurns(harness, thread.id).length;

        await expect(
          deliverWithLandingDuringHook(harness, thread.id, landing, {
            action: "proceed",
          }),
        ).resolves.toBe(false);

        expect(requestedTurns(harness, thread.id)).toHaveLength(
          requestedBefore,
        );
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
    });

    it("refuses the starting-turn fast path", async () => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFixture({ harness, status: "active", value: 4 });

        await expect(
          deliverWithLandingDuringHook(harness, thread.id, landing, {
            action: "proceed",
          }),
        ).resolves.toBe(false);

        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
      });
    });

    it("refuses the held queued create", async () => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFixture({ harness, status: "idle", value: 5 });
        const warn = vi.spyOn(harness.deps.logger, "warn");

        await expect(
          deliverWithLandingDuringHook(harness, thread.id, landing, {
            action: "wait",
            reason: "Holding",
          }),
        ).resolves.toBe(false);

        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            parentThreadId: thread.id,
            phase: "post-hook",
            dropped: true,
          }),
          expect.any(String),
        );
      });
    });
  },
);
