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

describe("cold tier parent-wake batch pins", () => {
  it("holds the child's pin from queueing until flush and refuses a move meanwhile", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child, ids, parent } = seedParentAndChild(harness);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnId: "turn-1",
        turnStatus: "completed",
      });
      expect(getThreadHistoryPinCount(child.id)).toBe(1);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, child.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      await flushChildThreadNotifications();
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });

  it("slot replacement acquires no second pin", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child, parent } = seedParentAndChild(harness);
      for (const turnStatus of ["failed", "completed"] as const) {
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: parent.id,
          turnId: "turn-1",
          turnStatus,
        });
      }
      expect(getThreadHistoryPinCount(child.id)).toBe(1);
      await flushChildThreadNotifications();
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });

  it("a batch for a missing parent still releases every pin", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child } = seedParentAndChild(harness);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: "missing-parent",
        turnId: "turn-1",
        turnStatus: "completed",
      });
      expect(getThreadHistoryPinCount(child.id)).toBe(1);
      await flushChildThreadNotifications();
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });

  it("overlapping batches for different parents hold separate pins and all release", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { child, parent, fixture } = seedParentAndChild(harness);
      const otherParent = seedThread(harness.deps, {
        environmentId: fixture.environment.id,
        projectId: fixture.project.id,
        title: "Other parent",
      });
      for (const parentThreadId of [parent.id, otherParent.id]) {
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId,
          turnId: "turn-1",
          turnStatus: "completed",
        });
      }
      expect(getThreadHistoryPinCount(child.id)).toBe(2);
      await flushChildThreadNotifications();
      expect(getThreadHistoryPinCount(child.id)).toBe(0);
    });
  });
});
