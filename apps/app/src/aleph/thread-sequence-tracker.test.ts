import { describe, expect, it } from "vitest";
import type { ChangedMessage } from "@bb/server-contract";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  THREAD_SEQUENCE_LONG_GAP_MS,
  ThreadSequenceTracker,
} from "./thread-sequence-tracker";

function statusChanged(
  id: string,
  updatedAt: number,
  displayStatus: "active" | "idle",
): ChangedMessage {
  const thread = makeThreadResponse({
    id,
    status: displayStatus,
    runtime: { displayStatus },
  });
  return {
    type: "changed",
    entity: "thread",
    id,
    changes: ["status-changed"],
    metadata: {
      statusChange: {
        activity: {
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activeGoalCount: 0,
          activePlanModeCount: 0,
          activeWorkflowCount: 0,
        },
        latestAttentionAt: 0,
        runtime: thread.runtime,
        status: thread.status,
        updatedAt,
      },
    },
  };
}

describe("ThreadSequenceTracker", () => {
  it("reports an older status update arriving after a newer one", () => {
    const tracker = new ThreadSequenceTracker();
    expect(tracker.observe(statusChanged("thr_1", 2000, "active"))).toBeNull();
    expect(tracker.observe(statusChanged("thr_1", 1500, "idle"))).toMatchObject(
      {
        anomaly: "out-of-order",
        deltaMs: -500,
        threadId: "thr_1",
      },
    );
  });

  it("reports a long silence after a busy status but not after an idle one", () => {
    const tracker = new ThreadSequenceTracker();
    tracker.observe(statusChanged("thr_busy", 1000, "active"));
    expect(
      tracker.observe(
        statusChanged(
          "thr_busy",
          1000 + THREAD_SEQUENCE_LONG_GAP_MS + 1,
          "idle",
        ),
      ),
    ).toMatchObject({ anomaly: "long-gap" });
    tracker.observe(statusChanged("thr_idle", 1000, "idle"));
    expect(
      tracker.observe(
        statusChanged(
          "thr_idle",
          1000 + THREAD_SEQUENCE_LONG_GAP_MS + 1,
          "active",
        ),
      ),
    ).toBeNull();
  });

  it("tracks threads independently and ignores messages without status", () => {
    const tracker = new ThreadSequenceTracker();
    tracker.observe(statusChanged("thr_a", 5000, "active"));
    expect(tracker.observe(statusChanged("thr_b", 100, "active"))).toBeNull();
    expect(
      tracker.observe({
        type: "changed",
        entity: "thread",
        id: "thr_a",
        changes: ["title-changed"],
      }),
    ).toBeNull();
  });
});
