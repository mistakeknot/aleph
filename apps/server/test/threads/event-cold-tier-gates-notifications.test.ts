import { describe, expect, it } from "vitest";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import {
  attemptColdMove,
  forceColdEligible,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import {
  flushChildThreadNotifications,
  withChildThreadNotificationClock,
} from "../helpers/child-thread-notification-clock.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import type { TestAppHarness } from "../helpers/test-app.js";

let counter = 0;

function seedParentAndChild(harness: TestAppHarness) {
  counter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-notify-${counter}` },
    environment: { path: `/tmp/cold-notify-${counter}` },
  });
  const child = seedThread(harness.deps, {
    environmentId: fixture.environment.id,
    parentThreadId: fixture.thread.id,
    projectId: fixture.project.id,
    title: "Worker",
  });
  seedColdTierEvents(harness.db, child.id);
  const ids = {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    threadId: child.id,
  };
  return { child, ids, parent: fixture.thread, fixture };
}

describe("cold tier parent-wake notices hold no pin", () => {
  it("captures the child's output at queue time so a move is not refused", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child, ids, parent } = seedParentAndChild(harness);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
      forceColdEligible(harness.db, ids);
      const moved = await attemptColdMove(harness, child.id);
      expect(moved).not.toMatchObject({ reason: "pinned" });
      await flushChildThreadNotifications(harness);
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });

  it("a notice for a missing parent holds no pin", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child } = seedParentAndChild(harness);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: "missing-parent",
        turnId: "turn-1",
        turnStatus: "completed",
      });
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
      await flushChildThreadNotifications(harness);
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });
});
