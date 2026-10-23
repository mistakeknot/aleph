import { describe, expect, it } from "vitest";
import { THREAD_CONTEXT_CLEAR_OPERATION } from "@bb/domain";
import { createEnvironment } from "../../src/data/environments.js";
import {
  COLD_SEGMENT_FORMAT_VERSION,
  ColdThreadHistoryError,
  ColdTransitionConflictError,
  commitColdMoveInTransaction,
  commitRehydrateInTransaction,
  findColdEligibilityFailure,
  getEventColdSegment,
  getThreadEventColdStateRow,
  getThreadEventHighWaterSequence,
  hashColdEventIds,
  hashColdRowsById,
  isThreadEventsCold,
  iterateColdMoveRows,
  listColdTierCandidateThreadIds,
  listColdThreadIds,
  listOpenBackgroundTaskItemRowsForThread,
  markOrphanedEventColdSegments,
  runColdTransition,
  selectThreadEventKeeperIds,
  type ColdEventRow,
} from "../../src/data/index.js";
import { insertEvents, type InsertEventInput } from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { ensureProjectAttachmentBackfill } from "../../src/data/project-attachment-backfill.js";
import { createProject } from "../../src/data/projects.js";
import { isThreadPastCompletedEventOutputSweeps } from "../../src/data/sweeps.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../../src/testing.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = 100 * DAY_MS;
const ELIGIBILITY = {
  minArchivedMs: 14 * DAY_MS,
  now: NOW,
  rehotCooldownMs: 7 * DAY_MS,
};

type Db = ReturnType<typeof createMigratedConnection>;

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/environment",
    providerOwnsPath: false,
    status: "ready",
    environmentProvider: null,
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    environmentId: environment.id,
    status: "idle",
  });
  return { db, environment, project, thread };
}

function makeEligible(
  db: Db,
  ids: { environmentId: string; projectId: string; threadId: string },
) {
  db.$client
    .prepare(
      "UPDATE environments SET status = 'destroyed', teardown_status = 'removed', owner_thread_id = NULL WHERE id = ?",
    )
    .run(ids.environmentId);
  db.$client
    .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
    .run(NOW - 30 * DAY_MS, ids.threadId);
  ensureProjectAttachmentBackfill(db, ids.projectId);
  db.$client
    .prepare(
      "UPDATE project_attachment_backfills SET phase = 'done' WHERE project_id = ?",
    )
    .run(ids.projectId);
  clearPruningWork(db, ids.threadId);
}

function clearPruningWork(db: Db, threadId: string) {
  db.$client
    .prepare("DELETE FROM thread_pruning_work WHERE thread_id = ?")
    .run(threadId);
}

function insertScanCursor(
  db: Db,
  policy: string,
  itemKind: string,
  outputPath: string,
  lastCreatedAt: number,
  lastEventId: string,
) {
  const id = [policy, "v1", itemKind, outputPath].join(":");
  db.$client
    .prepare(
      "INSERT INTO maintenance_scan_cursors (id, policy, version, item_kind, output_path, last_created_at, last_event_id, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, 0)",
    )
    .run(id, policy, itemKind, outputPath, lastCreatedAt, lastEventId);
  return id;
}

function event(
  threadId: string,
  sequence: number,
  type: InsertEventInput["type"],
  data: unknown,
  extra: Partial<InsertEventInput> = {},
): InsertEventInput {
  return {
    threadId,
    scope: { kind: "thread" },
    sequence,
    type,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    createdAt: sequence,
    data: JSON.stringify(data),
    ...extra,
  };
}

function eventIdsBySequence(db: Db, threadId: string): Map<number, string> {
  return new Map(
    db.$client
      .prepare<[string], { id: string; sequence: number }>(
        "SELECT id, sequence FROM events WHERE thread_id = ?",
      )
      .all(threadId)
      .map((row) => [row.sequence, row.id]),
  );
}

function seedHistory(db: Db, threadId: string) {
  insertEvents(db, noopNotifier, [
    event(threadId, 1, "thread/identity", { name: "a" }),
    event(threadId, 2, "client/turn/requested", { input: [] }),
    event(
      threadId,
      3,
      "item/started",
      { item: { text: "" } },
      {
        itemId: "msg-1",
        itemKind: "agentMessage",
      },
    ),
    event(
      threadId,
      4,
      "item/completed",
      { item: { text: "first" } },
      {
        itemId: "msg-1",
        itemKind: "agentMessage",
      },
    ),
    event(threadId, 5, "system/error", { message: "boom" }),
    event(threadId, 6, "client/turn/requested", { input: [] }),
    event(
      threadId,
      7,
      "item/started",
      { item: { text: "" } },
      {
        itemId: "msg-2",
        itemKind: "agentMessage",
      },
    ),
    event(
      threadId,
      8,
      "item/completed",
      { item: { text: "second" } },
      {
        itemId: "msg-2",
        itemKind: "agentMessage",
      },
    ),
    event(threadId, 9, "system/operation", {
      operation: THREAD_CONTEXT_CLEAR_OPERATION,
      status: "completed",
    }),
    event(threadId, 10, "thread/goal/updated", { goal: "g" }),
    event(threadId, 11, "thread/extensionState/updated", { kind: "a" }),
    event(threadId, 12, "thread/extensionState/updated", { kind: "b" }),
    event(threadId, 13, "thread/extensionState/updated", { kind: "a" }),
    event(
      threadId,
      14,
      "item/started",
      { item: { text: "" } },
      {
        itemId: "msg-3",
        itemKind: "agentMessage",
      },
    ),
  ]);
}

function prepareMove(db: Db, threadId: string) {
  const keeperIds = selectThreadEventKeeperIds(db, threadId);
  const rows = [...iterateColdMoveRows(db, threadId, keeperIds)];
  const movedEventIds = rows.map((row) => row.id);
  const { bodySha256, rowCount } = hashColdRowsById(
    db,
    threadId,
    movedEventIds,
  );
  return {
    keeperIds,
    rows,
    args: {
      eligibility: ELIGIBILITY,
      expectedHighWaterSequence: getThreadEventHighWaterSequence(db, threadId),
      expectedKeeperIds: keeperIds,
      movedEventIds,
      segment: {
        bodySha256,
        createdAt: NOW,
        decompressedBytes: 0,
        eventIdsSha256: hashColdEventIds(movedEventIds),
        fileBytes: 0,
        fileSha256: "f".repeat(64),
        firstSequence: rows[0]?.sequence ?? 0,
        formatVersion: COLD_SEGMENT_FORMAT_VERSION,
        headerBytes: 0,
        lastSequence: rows.at(-1)?.sequence ?? 0,
        path: `segments/${threadId}/seg-1.zst`,
        rowCount,
        segmentId: "seg-1",
        threadId,
        transformVersions: "{}",
      },
    },
  };
}

function readRows(db: Db, threadId: string): ColdEventRow[] {
  return db.$client
    .prepare<
      [string],
      ColdEventRow
    >("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")
    .all(threadId);
}

describe("selectThreadEventKeeperIds", () => {
  it("keeps the predicates readers depend on and their item completions", () => {
    const { db, thread } = setup();
    seedHistory(db, thread.id);
    const ids = eventIdsBySequence(db, thread.id);

    const keepers = selectThreadEventKeeperIds(db, thread.id);

    const keptSequences = [...ids.entries()]
      .filter(([, id]) => keepers.includes(id))
      .map(([sequence]) => sequence)
      .sort((a, b) => a - b);
    expect(keptSequences).toEqual([1, 5, 6, 8, 9, 10, 12, 13, 14]);
    expect(keepers).toEqual([...keepers].sort());
  });

  it("keeps the first spawnAgent tool call", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      event(
        thread.id,
        1,
        "item/completed",
        { item: { tool: "spawnAgent" } },
        {
          itemId: "tool-1",
          itemKind: "toolCall",
        },
      ),
      event(
        thread.id,
        2,
        "item/completed",
        { item: { tool: "spawnAgent" } },
        {
          itemId: "tool-2",
          itemKind: "toolCall",
        },
      ),
      event(thread.id, 3, "thread/identity", {}),
    ]);
    const ids = eventIdsBySequence(db, thread.id);

    expect(selectThreadEventKeeperIds(db, thread.id).sort()).toEqual(
      [ids.get(1), ids.get(3)].sort(),
    );
  });
});

describe("findColdEligibilityFailure", () => {
  it("accepts a settled archived thread and reports each blocker", () => {
    const { db, environment, project, thread } = setup();
    seedHistory(db, thread.id);
    const ids = {
      environmentId: environment.id,
      projectId: project.id,
      threadId: thread.id,
    };

    expect(findColdEligibilityFailure(db, thread.id, ELIGIBILITY)).toBe(
      "not_archived",
    );
    makeEligible(db, ids);
    expect(findColdEligibilityFailure(db, thread.id, ELIGIBILITY)).toBeNull();
    expect(
      listColdTierCandidateThreadIds(db, {
        limit: 10,
        minArchivedMs: ELIGIBILITY.minArchivedMs,
        now: NOW,
      }),
    ).toEqual([thread.id]);

    const run = (statement: string, ...params: unknown[]) =>
      db.$client.prepare(statement).run(...params);
    const expectFailure = (
      reason: string,
      apply: () => void,
      revert: () => void,
    ) => {
      apply();
      if (reason !== "pruning_pending") {
        clearPruningWork(db, thread.id);
      }
      expect(findColdEligibilityFailure(db, thread.id, ELIGIBILITY)).toBe(
        reason,
      );
      revert();
      expect(findColdEligibilityFailure(db, thread.id, ELIGIBILITY)).toBeNull();
    };

    expectFailure(
      "archived_too_recently",
      () =>
        run(
          "UPDATE threads SET archived_at = ? WHERE id = ?",
          NOW - DAY_MS,
          thread.id,
        ),
      () =>
        run(
          "UPDATE threads SET archived_at = ? WHERE id = ?",
          NOW - 30 * DAY_MS,
          thread.id,
        ),
    );
    expectFailure(
      "deleted",
      () =>
        run(
          "UPDATE threads SET storage_deleted_at = 1 WHERE id = ?",
          thread.id,
        ),
      () =>
        run(
          "UPDATE threads SET storage_deleted_at = NULL WHERE id = ?",
          thread.id,
        ),
    );
    expectFailure(
      "status_unsettled",
      () =>
        run("UPDATE threads SET status = 'stopping' WHERE id = ?", thread.id),
      () => run("UPDATE threads SET status = 'idle' WHERE id = ?", thread.id),
    );
    expectFailure(
      "maintenance_busy",
      () => run("UPDATE threads SET status = 'active' WHERE id = ?", thread.id),
      () => run("UPDATE threads SET status = 'idle' WHERE id = ?", thread.id),
    );
    expectFailure(
      "environment_teardown_not_removed",
      () =>
        run(
          "UPDATE environments SET teardown_status = 'failed' WHERE id = ?",
          environment.id,
        ),
      () =>
        run(
          "UPDATE environments SET teardown_status = 'removed' WHERE id = ?",
          environment.id,
        ),
    );
    expectFailure(
      "environment_not_destroyed",
      () =>
        run(
          "UPDATE environments SET status = 'error' WHERE id = ?",
          environment.id,
        ),
      () =>
        run(
          "UPDATE environments SET status = 'destroyed' WHERE id = ?",
          environment.id,
        ),
    );
    expectFailure(
      "environment_owned",
      () =>
        run(
          "UPDATE environments SET owner_thread_id = ? WHERE id = ?",
          thread.id,
          environment.id,
        ),
      () =>
        run(
          "UPDATE environments SET owner_thread_id = NULL WHERE id = ?",
          environment.id,
        ),
    );
    expectFailure(
      "environment_missing",
      () =>
        run("UPDATE threads SET environment_id = NULL WHERE id = ?", thread.id),
      () =>
        run(
          "UPDATE threads SET environment_id = ? WHERE id = ?",
          environment.id,
          thread.id,
        ),
    );
    expectFailure(
      "attachment_backfill_incomplete",
      () =>
        run(
          "UPDATE project_attachment_backfills SET phase = 'events' WHERE project_id = ?",
          project.id,
        ),
      () =>
        run(
          "UPDATE project_attachment_backfills SET phase = 'done' WHERE project_id = ?",
          project.id,
        ),
    );
    expectFailure(
      "pruning_pending",
      () =>
        run(
          "INSERT INTO thread_pruning_work (policy, thread_id, revision) VALUES ('p', ?, 1)",
          thread.id,
        ),
      () =>
        run("DELETE FROM thread_pruning_work WHERE thread_id = ?", thread.id),
    );
    expectFailure(
      "rehot_cooldown",
      () =>
        run(
          "INSERT INTO thread_event_cold_state (thread_id, state, live_segment_id, last_rehydrated_at) VALUES (?, 'hot', NULL, ?)",
          thread.id,
          NOW - DAY_MS,
        ),
      () =>
        run(
          "DELETE FROM thread_event_cold_state WHERE thread_id = ?",
          thread.id,
        ),
    );
    expectFailure(
      "open_turn",
      () =>
        insertEvents(db, noopNotifier, [
          event(
            thread.id,
            15,
            "turn/started",
            {},
            {
              scope: { kind: "turn", turnId: "turn-1" },
            },
          ),
        ]),
      () =>
        run(
          "DELETE FROM events WHERE thread_id = ? AND sequence = 15",
          thread.id,
        ),
    );
    expectFailure(
      "sweeps_incomplete",
      () =>
        insertEvents(db, noopNotifier, [
          event(
            thread.id,
            15,
            "item/completed",
            { item: {} },
            {
              itemId: "cmd-1",
              itemKind: "commandExecution",
            },
          ),
        ]),
      () =>
        run(
          "DELETE FROM events WHERE thread_id = ? AND sequence = 15",
          thread.id,
        ),
    );
  });
});

describe("isThreadPastCompletedEventOutputSweeps", () => {
  it("requires every sweep cursor to have passed the thread's rows", () => {
    const { db, thread } = setup();
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(true);
    insertEvents(db, noopNotifier, [
      event(
        thread.id,
        1,
        "item/completed",
        { item: {} },
        {
          itemId: "cmd-1",
          itemKind: "commandExecution",
          createdAt: 50,
        },
      ),
    ]);
    const eventId = eventIdsBySequence(db, thread.id).get(1)!;
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(false);

    const cursorId = insertScanCursor(
      db,
      "legacy_completed_event_output_sidecar",
      "commandExecution",
      "aggregatedOutput",
      50,
      "",
    );
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(false);
    db.$client
      .prepare(
        "UPDATE maintenance_scan_cursors SET last_event_id = ? WHERE id = ?",
      )
      .run(eventId, cursorId);
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(true);
    db.$client
      .prepare(
        "UPDATE maintenance_scan_cursors SET last_created_at = -1, last_event_id = '' WHERE id = ?",
      )
      .run(cursorId);
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(true);

    insertEvents(db, noopNotifier, [
      event(thread.id, 2, "provider/unhandled", {}),
    ]);
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(false);
    insertScanCursor(
      db,
      "legacy_image_generation_output_sidecar",
      "imageGeneration",
      "result",
      -1,
      "",
    );
    expect(isThreadPastCompletedEventOutputSweeps(db, thread.id)).toBe(true);
  });
});

describe("cold move and rehydrate", () => {
  function eligibleThread() {
    const ctx = setup();
    seedHistory(ctx.db, ctx.thread.id);
    makeEligible(ctx.db, {
      environmentId: ctx.environment.id,
      projectId: ctx.project.id,
      threadId: ctx.thread.id,
    });
    return ctx;
  }

  it("moves non-keeper rows, blocks writers, and rehydrates them byte for byte", () => {
    const { db, thread } = eligibleThread();
    const before = readRows(db, thread.id);
    const { args, keeperIds, rows } = prepareMove(db, thread.id);
    expect(rows.length).toBe(before.length - keeperIds.length);

    runColdTransition(db, thread.id, () =>
      commitColdMoveInTransaction(db, args),
    );

    expect(isThreadEventsCold(db, thread.id)).toBe(true);
    expect(listColdThreadIds(db, [thread.id, "other"])).toEqual([thread.id]);
    expect(
      readRows(db, thread.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual(keeperIds);
    expect(getEventColdSegment(db, "seg-1")?.lifecycle).toBe("live");
    expect(findColdEligibilityFailure(db, thread.id, ELIGIBILITY)).toBe(
      "already_cold",
    );
    expect(() =>
      insertEvents(db, noopNotifier, [
        event(thread.id, 15, "system/error", {}),
      ]),
    ).toThrow(ColdThreadHistoryError);
    expect(
      listOpenBackgroundTaskItemRowsForThread(db, { threadId: thread.id }),
    ).toEqual([]);

    runColdTransition(db, thread.id, () =>
      commitRehydrateInTransaction(db, {
        now: NOW + 1,
        retainedOutputs: [],
        rows,
        segmentId: "seg-1",
        threadId: thread.id,
      }),
    );

    expect(readRows(db, thread.id)).toEqual(before);
    expect(getThreadEventColdStateRow(db, thread.id)).toMatchObject({
      state: "hot",
      liveSegmentId: null,
      lastRehydratedAt: NOW + 1,
    });
    expect(getEventColdSegment(db, "seg-1")).toMatchObject({
      lifecycle: "rehydrated",
      endedAt: NOW + 1,
    });
    expect(
      findColdEligibilityFailure(db, thread.id, {
        ...ELIGIBILITY,
        now: NOW + 2,
      }),
    ).toBe("rehot_cooldown");
  });

  it("rolls back when history changed after the segment was written", () => {
    const { db, thread } = eligibleThread();
    const before = readRows(db, thread.id);
    const { args } = prepareMove(db, thread.id);
    insertEvents(db, noopNotifier, [event(thread.id, 15, "system/error", {})]);

    expect(() =>
      runColdTransition(db, thread.id, () =>
        commitColdMoveInTransaction(db, args),
      ),
    ).toThrow(ColdTransitionConflictError);
    expect(isThreadEventsCold(db, thread.id)).toBe(false);
    expect(getEventColdSegment(db, "seg-1")).toBeNull();
    expect(readRows(db, thread.id).length).toBe(before.length + 1);
    expect(db.$client.inTransaction).toBe(false);
  });

  it("refuses a move that changes moved rows", () => {
    const { db, thread } = eligibleThread();
    const { args } = prepareMove(db, thread.id);
    db.$client
      .prepare("UPDATE events SET data = '{}' WHERE id = ?")
      .run(args.movedEventIds[0]);

    expect(() =>
      runColdTransition(db, thread.id, () =>
        commitColdMoveInTransaction(db, args),
      ),
    ).toThrow(/moved_rows_changed/);
  });

  it("nulls a missing environment on rehydrate and refuses overlapping sequences", () => {
    const { db, environment, thread } = eligibleThread();
    db.$client
      .prepare("UPDATE events SET environment_id = ? WHERE thread_id = ?")
      .run(environment.id, thread.id);
    const { args, rows } = prepareMove(db, thread.id);
    runColdTransition(db, thread.id, () =>
      commitColdMoveInTransaction(db, args),
    );
    const ghostRows = rows.map((row) => ({
      ...row,
      environment_id: "env-gone",
    }));

    expect(() =>
      runColdTransition(db, thread.id, () =>
        commitRehydrateInTransaction(db, {
          now: NOW,
          retainedOutputs: [],
          rows: [...ghostRows, { ...ghostRows[0]!, id: "dup" }],
          segmentId: "seg-1",
          threadId: thread.id,
        }),
      ),
    ).toThrow();
    expect(isThreadEventsCold(db, thread.id)).toBe(true);

    runColdTransition(db, thread.id, () =>
      commitRehydrateInTransaction(db, {
        now: NOW,
        retainedOutputs: [],
        rows: ghostRows,
        segmentId: "seg-1",
        threadId: thread.id,
      }),
    );
    expect(
      db.$client
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM events WHERE thread_id = ? AND environment_id IS NULL")
        .get(thread.id)?.n,
    ).toBe(rows.length);
  });

  it("marks live segments of vanished threads orphaned", () => {
    const { db, thread } = eligibleThread();
    const { args } = prepareMove(db, thread.id);
    runColdTransition(db, thread.id, () =>
      commitColdMoveInTransaction(db, args),
    );
    db.$client.pragma("foreign_keys = OFF");
    db.$client.prepare("DELETE FROM threads WHERE id = ?").run(thread.id);
    db.$client.pragma("foreign_keys = ON");

    expect(markOrphanedEventColdSegments(db, NOW)).toEqual(["seg-1"]);
    expect(getEventColdSegment(db, "seg-1")?.lifecycle).toBe("orphaned");
  });

  it("refuses to start inside an open transaction", () => {
    const { db, thread } = eligibleThread();
    db.$client.exec("BEGIN");
    expect(() => runColdTransition(db, thread.id, () => 1)).toThrow(
      /inside a transaction/,
    );
    db.$client.exec("ROLLBACK");
  });
});
