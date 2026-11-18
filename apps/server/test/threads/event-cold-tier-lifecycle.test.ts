import {
  isThreadEventsCold,
  readThreadRunState,
  threadRunStates,
  threadTurnRequests,
  markThreadDeleted,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import {
  recoverThreadLifecyclesAfterRestart,
  finalizeStoppedThreadInTransaction,
  reconcileDaemonReportedThreads,
  resendStopsAwaitingDaemon,
} from "../../src/services/threads/thread-lifecycle.js";
import { runReleasedTurnFollowUps } from "../../src/services/threads/turn-end-follow-ups.js";
import {
  attemptColdMove,
  forceColdEligible,
  forceColdStateRow,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seed(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, { thread: { status: "idle" } });
  seedColdTierEvents(harness.db, fixture.thread.id);
  forceColdEligible(harness.db, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
  });
  return fixture;
}

function request(
  harness: TestAppHarness,
  threadId: string,
  hostId: string,
  phase: "sent" | "accepted" = "sent",
) {
  harness.db
    .insert(threadTurnRequests)
    .values({
      requestId: `creq_${threadId}`,
      threadId,
      hostId,
      kind: "steer",
      phase,
      sentAt: 1,
      syncTitle: false,
    })
    .run();
}

describe("persisted lifecycle cold-history boundaries", () => {
  it.each(["request", "held-completion", "unacknowledged-stop"] as const)(
    "blocks cold moves for %s",
    async (condition) => {
      await withTestHarness(async (harness) => {
        const { thread, host } = seed(harness);
        if (condition === "request") request(harness, thread.id, host.id);
        else
          harness.db
            .insert(threadRunStates)
            .values({
              threadId: thread.id,
              updatedAt: 1,
              ...(condition === "held-completion"
                ? { heldTurnId: "turn-1", heldTurnStatus: "completed" as const }
                : { stopReason: "manual-stop" as const, stopRequestedAt: 1 }),
            })
            .run();
        expect(await attemptColdMove(harness, thread.id)).toMatchObject({
          outcome: "skipped",
          reason: "lifecycle_in_flight",
        });
        expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      });
    },
  );

  it("allows an acknowledged stop fence alone to move cold", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seed(harness);
      harness.db
        .insert(threadRunStates)
        .values({
          threadId: thread.id,
          updatedAt: 1,
          stopReason: "manual-stop",
          stopRequestedAt: 1,
          stopAckedAt: 2,
        })
        .run();
      expect((await attemptColdMove(harness, thread.id)).outcome).toBe("moved");
      expect(readThreadRunState(harness.db, thread.id).stop?.ackedAt).toBe(2);
    });
  });

  it("hydrates a restart candidate before the lifecycle loader reads history", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host } = seed(harness);
      expect((await attemptColdMove(harness, thread.id)).outcome).toBe("moved");
      // Model recovery of persisted control state; normal moves already exclude it.
      request(harness, thread.id, host.id, "accepted");
      expect(await recoverThreadLifecyclesAfterRestart(harness.deps)).toBe(1);
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(readThreadRunState(harness.db, thread.id).requests).toEqual([]);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("finalizes deleted cold threads without opening a missing archive", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seed(harness);
      forceColdStateRow(harness.db, thread.id);
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      const outcome = harness.db.transaction((db) =>
        finalizeStoppedThreadInTransaction(
          { ...harness.deps, db },
          { threadId: thread.id, fence: false },
        ),
      );
      expect(outcome.refusal).toBeNull();
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(true);
    });
  });

  it("hydrates the widened reconnect candidate set before event scans", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host } = seed(harness);
      expect((await attemptColdMove(harness, thread.id)).outcome).toBe("moved");
      request(harness, thread.id, host.id, "accepted");
      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        turnCommandThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: true,
      });
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("holds the socket-opened resend operation until its history gate resolves", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host } = seed(harness);
      expect((await attemptColdMove(harness, thread.id)).outcome).toBe("moved");
      harness.db
        .insert(threadRunStates)
        .values({
          threadId: thread.id,
          updatedAt: 1,
          stopReason: "manual-stop",
          stopRequestedAt: 1,
        })
        .run();
      resendStopsAwaitingDaemon(harness.deps, host.id);
      await vi.waitFor(() => {
        expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
        expect(
          readThreadRunState(harness.db, thread.id).stop?.sentAt,
        ).not.toBeNull();
      });
    });
  });

  it("hydrates released-completion planning independently of event ingestion", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seed(harness);
      expect((await attemptColdMove(harness, thread.id)).outcome).toBe("moved");
      await runReleasedTurnFollowUps(harness.deps, {
        threadId: thread.id,
        turnId: "turn-1",
        status: "failed",
      });
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });
});
