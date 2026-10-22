import {
  insertEvents,
  noopNotifier,
  projectAttachmentBackfills,
  type DbConnection,
} from "@bb/db";
import type { EventColdTierConfig } from "../../src/services/threads/event-cold-tier/config.js";
import {
  moveThreadEventsToColdTier,
  type ColdMoveResult,
  type EventColdTierDeps,
} from "../../src/services/threads/event-cold-tier/service.js";
import type { TestAppHarness } from "./test-app.js";

export const DAY_MS = 24 * 60 * 60_000;
export const COLD_NOW = 100 * DAY_MS;

export const COLD_CONFIG: EventColdTierConfig = {
  maxThreadBytes: 32 * 1024 * 1024,
  maxThreadBytesClamped: false,
  minArchivedMs: 14 * DAY_MS,
  mode: "on",
  rehotCooldownMs: 7 * DAY_MS,
};

export function seedColdTierEvents(
  db: DbConnection,
  threadId: string,
  options: { count?: number; identity?: boolean; startSequence?: number } = {},
): void {
  const count = options.count ?? 40;
  const startSequence = options.startSequence ?? 1;
  insertEvents(db, noopNotifier, [
    ...(options.identity === false
      ? []
      : [
          {
            threadId,
            scope: { kind: "thread" as const },
            sequence: 1,
            type: "thread/identity" as const,
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            createdAt: 1,
            data: JSON.stringify({ name: "a" }),
          },
        ]),
    ...Array.from({ length: count }, (_, index) => ({
      threadId,
      scope: { kind: "turn" as const, turnId: "turn-1" },
      sequence: index + startSequence + 1,
      type: "turn/diff/updated" as const,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      createdAt: index + 2,
      data: JSON.stringify({ diff: `diff ${index} ${"x".repeat(64)}` }),
    })),
  ]);
}

export function forceColdEligible(
  db: DbConnection,
  ids: { environmentId: string; projectId: string; threadId: string },
): void {
  db.$client
    .prepare(
      "UPDATE environments SET status = 'destroyed', teardown_status = 'removed', owner_thread_id = NULL WHERE id = ?",
    )
    .run(ids.environmentId);
  db.$client
    .prepare("UPDATE threads SET archived_at = ?, status = 'idle' WHERE id = ?")
    .run(COLD_NOW - 30 * DAY_MS, ids.threadId);
  db.insert(projectAttachmentBackfills)
    .values({
      projectId: ids.projectId,
      phase: "done",
      threadCursor: "",
      inputCursor: 0,
      inputId: "",
      inputSequence: 0,
      attemptedAt: 0,
      error: null,
    })
    .onConflictDoNothing()
    .run();
  db.$client
    .prepare("DELETE FROM thread_pruning_work WHERE thread_id = ?")
    .run(ids.threadId);
}

export function attemptColdMove(
  harness: TestAppHarness,
  threadId: string,
): Promise<ColdMoveResult> {
  return moveThreadEventsToColdTier(
    harness.deps as unknown as EventColdTierDeps,
    threadId,
    { config: COLD_CONFIG, now: COLD_NOW },
  );
}

export function forceColdStateRow(db: DbConnection, threadId: string): void {
  db.$client
    .prepare(
      "INSERT INTO thread_event_cold_state (thread_id, state, live_segment_id, last_rehydrated_at) VALUES (?, 'cold', ?, NULL)",
    )
    .run(threadId, `forced-segment-${threadId}`);
}

export function countThreadEvents(db: DbConnection, threadId: string): number {
  return (
    db.$client
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM events WHERE thread_id = ?",
      )
      .get(threadId)?.count ?? 0
  );
}
