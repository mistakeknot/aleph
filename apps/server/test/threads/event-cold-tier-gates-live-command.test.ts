import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  runLiveHostCommand,
  startLiveHostCommand,
} from "../../src/services/hosts/live-command.js";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import { buildThreadStorageDeleteCommand } from "../../src/services/threads/thread-commands.js";
import {
  attemptColdMove,
  forceColdEligible,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

let counter = 0;

function seedCommandFixture(harness: TestAppHarness) {
  counter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-live-${counter}` },
    environment: { path: `/tmp/cold-live-${counter}` },
  });
  seedColdTierEvents(harness.db, fixture.thread.id);
  const command = buildThreadStorageDeleteCommand({
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
  });
  const ids = {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    threadId: fixture.thread.id,
  };
  return { command, fixture, ids };
}

function successResponse(requestId: string) {
  return {
    type: "host-rpc.response" as const,
    requestId,
    commandType: "thread.storage.delete" as const,
    ok: true as const,
    result: { providerCheckpointId: null },
  };
}

describe("cold tier live host command pin", () => {
  it("holds the pin across the RPC, refuses a move, and releases on success", async () => {
    await withTestHarness(async (harness) => {
      const { command, fixture, ids } = seedCommandFixture(harness);
      const gate = createDeferredPromise<void>();
      vi.spyOn(harness.hub, "requestHostOnlineRpc").mockImplementation(
        async ({ message }) => {
          await gate.promise;
          return successResponse(message.requestId);
        },
      );
      const running = runLiveHostCommand(harness.deps, {
        command,
        hostId: fixture.host.id,
        timeoutMs: 1000,
      });
      expect(getThreadHistoryPinCount(fixture.thread.id)).toBe(1);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, fixture.thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      gate.resolve();
      await running;
      expect(getThreadHistoryPinCount(fixture.thread.id)).toBe(0);
    });
  });

  it("releases on RPC failure and on the preserveOnHostUnavailable rethrow", async () => {
    await withTestHarness(async (harness) => {
      const { command, fixture } = seedCommandFixture(harness);
      const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");
      request.mockRejectedValueOnce(new Error("rpc exploded"));
      await expect(
        runLiveHostCommand(harness.deps, {
          command,
          hostId: fixture.host.id,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("rpc exploded");
      expect(getThreadHistoryPinCount(fixture.thread.id)).toBe(0);

      request.mockRejectedValueOnce(
        new ApiError(502, "host_unavailable", "Host is not connected"),
      );
      await expect(
        runLiveHostCommand(harness.deps, {
          command,
          hostId: fixture.host.id,
          preserveOnHostUnavailable: true,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("Host is not connected");
      expect(getThreadHistoryPinCount(fixture.thread.id)).toBe(0);
    });
  });

  it("startLiveHostCommand keeps the pin held while onSettled runs and releases after", async () => {
    await withTestHarness(async (harness) => {
      const { command, fixture } = seedCommandFixture(harness);
      vi.spyOn(harness.hub, "requestHostOnlineRpc").mockImplementation(
        async ({ message }) => successResponse(message.requestId),
      );
      const settled = createDeferredPromise<number>();
      startLiveHostCommand(harness.deps, {
        command,
        hostId: fixture.host.id,
        onSettled: () => {
          settled.resolve(getThreadHistoryPinCount(fixture.thread.id));
        },
        timeoutMs: 1000,
      });
      expect(await settled.promise).toBeGreaterThan(0);
      await vi.waitFor(() =>
        expect(getThreadHistoryPinCount(fixture.thread.id)).toBe(0),
      );
    });
  });
});
