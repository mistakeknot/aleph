import { getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  admitThreadAsProvisionalSuccessor,
  ensureProvisionalSuccessorFenceOpen,
  evaluateProvisionalSuccessorFence,
  releaseProvisionalSuccessorFence,
  verifyThreadProvisionalSuccessorCheckpoint,
} from "../../src/services/threads/provisional-successor-fence.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/provisional-successor-fence-project";

function seedRunnableThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
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
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });
  return { environment, project, thread };
}

async function expectApiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

describe("evaluateProvisionalSuccessorFence", () => {
  it("reads an unadmitted thread (epoch: null) as unfenced", () => {
    expect(
      evaluateProvisionalSuccessorFence({ epoch: null, verifiedEpoch: null }),
    ).toEqual({ fenced: false });
  });

  it("reads an admitted, unverified thread as fenced", () => {
    expect(
      evaluateProvisionalSuccessorFence({ epoch: 1, verifiedEpoch: null }),
    ).toEqual({ fenced: true, epoch: 1 });
  });

  it("reads a thread verified at an older epoch as still fenced", () => {
    expect(
      evaluateProvisionalSuccessorFence({ epoch: 2, verifiedEpoch: 1 }),
    ).toEqual({ fenced: true, epoch: 2 });
  });

  it("reads a thread verified at the current epoch as unfenced", () => {
    expect(
      evaluateProvisionalSuccessorFence({ epoch: 1, verifiedEpoch: 1 }),
    ).toEqual({ fenced: false });
  });
});

describe("provisional successor fence storage", () => {
  it("does nothing for a thread that was never admitted", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, "host-never-admitted");
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).not.toThrow();
    });
  });

  it("blocks dispatch after admission and clears once verified", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, "host-admit-verify");
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).toThrow(ApiError);

      const verified = verifyThreadProvisionalSuccessorCheckpoint(
        harness.deps,
        { threadId: thread.id, epoch: 1 },
      );
      expect(verified).toBe(true);
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).not.toThrow();
    });
  });

  it("fails closed: a verification for a stale epoch never opens the fence", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, "host-stale-epoch");
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });
      // A source thread re-admits with a fresh checkpoint (epoch 2) before a
      // late verification response for epoch 1 lands.
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 2,
      });
      const staleVerified = verifyThreadProvisionalSuccessorCheckpoint(
        harness.deps,
        { threadId: thread.id, epoch: 1 },
      );
      expect(staleVerified).toBe(false);
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).toThrow(ApiError);

      const currentVerified = verifyThreadProvisionalSuccessorCheckpoint(
        harness.deps,
        { threadId: thread.id, epoch: 2 },
      );
      expect(currentVerified).toBe(true);
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).not.toThrow();
    });
  });

  it("releasing the fence returns the thread to ordinary behavior", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, "host-release");
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });
      releaseProvisionalSuccessorFence(harness.deps, thread.id);
      expect(() =>
        ensureProvisionalSuccessorFenceOpen(harness.deps, thread),
      ).not.toThrow();
    });
  });
});

describe("the dispatch checkpoint enforces the fence non-bypassably", () => {
  it("rejects a send on a fenced thread with no plugin hook installed", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, "host-checkpoint-reject");
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });

      const error = await expectApiError(() =>
        acceptThreadSendRequest(harness.deps, {
          payload: { input: textInput("do native work"), mode: "auto" },
          thread,
        }),
      );
      expect(error.body.code).toBe("provisional_successor_fenced");
      expect(error.status).toBe(403);
    });
  });

  it("dispatches normally once the checkpoint is verified", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(
        harness,
        "host-checkpoint-verified",
      );
      admitThreadAsProvisionalSuccessor(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });
      verifyThreadProvisionalSuccessorCheckpoint(harness.deps, {
        threadId: thread.id,
        epoch: 1,
      });

      const response = await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("verified work"), mode: "auto" },
        thread: getThread(harness.db, thread.id)!,
      });
      expect(response.ok).toBe(true);
    });
  });
});
