import { createHash } from "node:crypto";
import {
  ARCHIVE_UNDO_GRACE_MS,
  THREAD_CONTEXT_CLEAR_OPERATION,
} from "@bb/domain";
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  eventColdSegments,
  threadEventColdState,
  type EventColdSegmentLifecycle,
} from "../schema.js";
import { bumpThreadEventRewriteGeneration } from "./event-rewrite-generation.js";
import {
  getActiveStoredTurnId,
  getHighWaterMarks,
  listOpenBackgroundTaskItemRowsForThread,
} from "./events.js";
import { isThreadMaintenanceBusy } from "./maintenance.js";
import { queryInSqliteVariableBatches } from "./sqlite-variable-batches.js";
import { isThreadPastCompletedEventOutputSweeps } from "./sweeps.js";

export const COLD_SEGMENT_FORMAT_VERSION = 1;

export const EVENT_COLD_COLUMNS = [
  "id",
  "thread_id",
  "environment_id",
  "scope_kind",
  "turn_id",
  "provider_thread_id",
  "sequence",
  "type",
  "item_id",
  "item_kind",
  "parent_tool_call_id",
  "data",
  "created_at",
] as const;

export interface ColdEventRow {
  id: string;
  thread_id: string;
  environment_id: string | null;
  scope_kind: string;
  turn_id: string | null;
  provider_thread_id: string | null;
  sequence: number;
  type: string;
  item_id: string | null;
  item_kind: string | null;
  parent_tool_call_id: string | null;
  data: string;
  created_at: number;
}

export class ColdThreadHistoryError extends Error {
  readonly threadIds: readonly string[];

  constructor(threadIds: readonly string[]) {
    super(
      `Thread history is in the cold tier and must be rehydrated first: ${threadIds.join(", ")}`,
    );
    this.name = "ColdThreadHistoryError";
    this.threadIds = threadIds;
  }
}

export type ThreadEventColdStateRow = typeof threadEventColdState.$inferSelect;
export type EventColdSegmentRow = typeof eventColdSegments.$inferSelect;

export function getThreadEventColdStateRow(
  db: DbQueryConnection,
  threadId: string,
): ThreadEventColdStateRow | null {
  return (
    db
      .select()
      .from(threadEventColdState)
      .where(eq(threadEventColdState.threadId, threadId))
      .get() ?? null
  );
}

export function isThreadEventsCold(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return getThreadEventColdStateRow(db, threadId)?.state === "cold";
}

export function listColdThreadIds(
  db: DbQueryConnection,
  threadIds: readonly string[],
): string[] {
  if (threadIds.length === 0) {
    return [];
  }
  return queryInSqliteVariableBatches({
    dedupeKey: (threadId) => threadId,
    fixedVariableCount: 0,
    queryBatch: (batch) =>
      db
        .select({ threadId: threadEventColdState.threadId })
        .from(threadEventColdState)
        .where(
          and(
            eq(threadEventColdState.state, "cold"),
            inArray(threadEventColdState.threadId, [...batch]),
          ),
        )
        .all(),
    values: [...threadIds],
    variableCountPerValue: 1,
  })
    .map((row) => row.threadId)
    .sort();
}

export function listAllColdThreadIds(db: DbQueryConnection): string[] {
  return db
    .select({ threadId: threadEventColdState.threadId })
    .from(threadEventColdState)
    .where(eq(threadEventColdState.state, "cold"))
    .orderBy(threadEventColdState.threadId)
    .all()
    .map((row) => row.threadId);
}

export function assertThreadEventsNotCold(
  db: DbQueryConnection,
  threadIds: readonly string[],
): void {
  const cold = listColdThreadIds(db, threadIds);
  if (cold.length > 0) {
    throw new ColdThreadHistoryError(cold);
  }
}

export function threadEventsNotCold(threadIdColumn: SQLWrapper): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM thread_event_cold_state
    WHERE thread_event_cold_state.thread_id = ${threadIdColumn}
      AND thread_event_cold_state.state = 'cold'
  )`;
}

const KEEPER_IDS_SQL = `
  WITH base AS (
    SELECT id FROM (
      SELECT id FROM events WHERE thread_id = @threadId
      ORDER BY sequence DESC LIMIT 1
    )
    UNION
    SELECT id FROM events
    WHERE thread_id = @threadId AND type = 'thread/identity'
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId
        AND type = 'system/operation'
        AND json_extract(data, '$.operation') = @contextClearOperation
        AND json_extract(data, '$.status') = 'completed'
      ORDER BY sequence DESC LIMIT 1
    )
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId
        AND type IN ('thread/goal/updated', 'thread/goal/cleared')
      ORDER BY sequence DESC LIMIT 1
    )
    UNION
    SELECT (
      SELECT latest.id FROM events AS latest
      WHERE latest.thread_id = @threadId
        AND latest.type = 'thread/extensionState/updated'
        AND json_extract(latest.data, '$.kind') IS kinds.kind
      ORDER BY latest.sequence DESC LIMIT 1
    )
    FROM (
      SELECT DISTINCT json_extract(data, '$.kind') AS kind
      FROM events
      WHERE thread_id = @threadId AND type = 'thread/extensionState/updated'
    ) AS kinds
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId
        AND (
          type = 'client/turn/requested'
          OR (
            type IN ('client/thread/start', 'client/turn/start')
            AND json_type(data, '$.input') IS NOT NULL
          )
        )
      ORDER BY sequence DESC LIMIT 1
    )
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId
        AND item_kind = 'toolCall'
        AND json_extract(data, '$.item.tool') = 'spawnAgent'
      ORDER BY sequence LIMIT 1
    )
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId
        AND (
          (
            type = 'system/manager/user_message'
            AND COALESCE(json_extract(data, '$.text'), '') <> ''
          )
          OR (
            type = 'item/completed'
            AND item_kind = 'agentMessage'
            AND COALESCE(json_extract(data, '$.item.text'), '') <> ''
          )
        )
      ORDER BY sequence DESC LIMIT 1
    )
    UNION
    SELECT id FROM (
      SELECT id FROM events
      WHERE thread_id = @threadId AND type = 'system/error'
      ORDER BY sequence DESC LIMIT 1
    )
  )
  SELECT id FROM base WHERE id IS NOT NULL
  UNION
  SELECT closure.id FROM events AS closure
  WHERE closure.thread_id = @threadId
    AND closure.type IN ('item/completed', 'item/backgroundTask/completed')
    AND closure.item_id IN (
      SELECT kept.item_id FROM events AS kept
      WHERE kept.id IN (SELECT id FROM base)
        AND kept.item_id IS NOT NULL
    )
  ORDER BY id
`;

export function selectThreadEventKeeperIds(
  db: DbQueryConnection,
  threadId: string,
): string[] {
  return (db as DbConnection).$client
    .prepare<
      { contextClearOperation: string; threadId: string },
      { id: string }
    >(KEEPER_IDS_SQL)
    .all({ contextClearOperation: THREAD_CONTEXT_CLEAR_OPERATION, threadId })
    .map((row) => row.id);
}

export const COLD_ELIGIBILITY_FAILURE_REASONS = [
  "thread_missing",
  "not_archived",
  "archived_too_recently",
  "deleted",
  "already_cold",
  "rehot_cooldown",
  "maintenance_busy",
  "status_unsettled",
  "open_turn",
  "open_background_task",
  "environment_missing",
  "environment_not_destroyed",
  "environment_teardown_not_removed",
  "environment_owned",
  "attachment_backfill_incomplete",
  "retained_output_unexpired",
  "pruning_pending",
  "pruning_cursor_active",
  "sweeps_incomplete",
] as const;

export type ColdEligibilityFailureReason =
  (typeof COLD_ELIGIBILITY_FAILURE_REASONS)[number];

export interface ColdEligibilityOptions {
  minArchivedMs: number;
  now: number;
  rehotCooldownMs: number;
}

interface ColdEligibilityFacts {
  archived_at: number | null;
  deleted_at: number | null;
  storage_deleted_at: number | null;
  status: string;
  environment_id: string | null;
  project_id: string;
  env_exists: number;
  env_status: string | null;
  env_teardown_status: string | null;
  env_owner_thread_id: string | null;
  cold_state: string | null;
  live_segment_id: string | null;
  last_rehydrated_at: number | null;
  busy: number;
  backfill_done: number;
  unexpired_outputs: number;
  pruning_work: number;
  pruning_cursor: number;
}

function readColdEligibilityFacts(
  db: DbQueryConnection,
  threadId: string,
  now: number,
): ColdEligibilityFacts | null {
  const busy = isThreadMaintenanceBusy(threadId);
  return (
    db.get<ColdEligibilityFacts>(sql`
      SELECT
        t.archived_at AS archived_at,
        t.deleted_at AS deleted_at,
        t.storage_deleted_at AS storage_deleted_at,
        t.status AS status,
        t.environment_id AS environment_id,
        t.project_id AS project_id,
        (e.id IS NOT NULL) AS env_exists,
        e.status AS env_status,
        e.teardown_status AS env_teardown_status,
        e.owner_thread_id AS env_owner_thread_id,
        cs.state AS cold_state,
        cs.live_segment_id AS live_segment_id,
        cs.last_rehydrated_at AS last_rehydrated_at,
        ${busy} AS busy,
        EXISTS (
          SELECT 1 FROM project_attachment_backfills b
          WHERE b.project_id = t.project_id AND b.phase = 'done'
        ) AS backfill_done,
        EXISTS (
          SELECT 1 FROM retained_event_outputs r
          JOIN events ev ON ev.id = r.event_id
          WHERE ev.thread_id = t.id AND r.expires_at > ${now}
        ) AS unexpired_outputs,
        EXISTS (
          SELECT 1 FROM thread_pruning_work w WHERE w.thread_id = t.id
        ) AS pruning_work,
        EXISTS (
          SELECT 1 FROM thread_pruning_cursors c WHERE c.current_thread_id = t.id
        ) AS pruning_cursor
      FROM threads t
      LEFT JOIN environments e ON e.id = t.environment_id
      LEFT JOIN thread_event_cold_state cs ON cs.thread_id = t.id
      WHERE t.id = ${threadId}
    `) ?? null
  );
}

export function findColdEligibilityFailure(
  db: DbQueryConnection,
  threadId: string,
  options: ColdEligibilityOptions,
): ColdEligibilityFailureReason | null {
  const facts = readColdEligibilityFacts(db, threadId, options.now);
  if (!facts) {
    return "thread_missing";
  }
  if (facts.deleted_at !== null || facts.storage_deleted_at !== null) {
    return "deleted";
  }
  if (facts.archived_at === null) {
    return "not_archived";
  }
  if (
    facts.archived_at > options.now - options.minArchivedMs ||
    facts.archived_at > options.now - ARCHIVE_UNDO_GRACE_MS
  ) {
    return "archived_too_recently";
  }
  if (facts.cold_state === "cold" || facts.live_segment_id !== null) {
    return "already_cold";
  }
  if (
    facts.last_rehydrated_at !== null &&
    facts.last_rehydrated_at > options.now - options.rehotCooldownMs
  ) {
    return "rehot_cooldown";
  }
  if (facts.busy) {
    return "maintenance_busy";
  }
  if (
    facts.status === "starting" ||
    facts.status === "active" ||
    facts.status === "stopping"
  ) {
    return "status_unsettled";
  }
  if (!facts.env_exists) {
    return "environment_missing";
  }
  if (facts.env_status !== "destroyed") {
    return "environment_not_destroyed";
  }
  if (facts.env_teardown_status !== "removed") {
    return "environment_teardown_not_removed";
  }
  if (facts.env_owner_thread_id !== null) {
    return "environment_owned";
  }
  if (!facts.backfill_done) {
    return "attachment_backfill_incomplete";
  }
  if (facts.unexpired_outputs) {
    return "retained_output_unexpired";
  }
  if (facts.pruning_work) {
    return "pruning_pending";
  }
  if (facts.pruning_cursor) {
    return "pruning_cursor_active";
  }
  if (getActiveStoredTurnId(db, threadId) !== null) {
    return "open_turn";
  }
  if (listOpenBackgroundTaskItemRowsForThread(db, { threadId }).length > 0) {
    return "open_background_task";
  }
  if (!isThreadPastCompletedEventOutputSweeps(db, threadId)) {
    return "sweeps_incomplete";
  }
  return null;
}

export function listColdTierCandidateThreadIds(
  db: DbQueryConnection,
  args: {
    afterThreadId?: string;
    limit: number;
    minArchivedMs: number;
    now: number;
  },
): string[] {
  const archivedBefore =
    args.now - Math.max(args.minArchivedMs, ARCHIVE_UNDO_GRACE_MS);
  return db
    .all<{ id: string }>(
      sql`
      SELECT t.id AS id
      FROM threads t
      WHERE t.archived_at IS NOT NULL
        AND t.archived_at <= ${archivedBefore}
        AND t.deleted_at IS NULL
        AND t.storage_deleted_at IS NULL
        AND t.id > ${args.afterThreadId ?? ""}
        AND NOT EXISTS (
          SELECT 1 FROM thread_event_cold_state cs
          WHERE cs.thread_id = t.id AND cs.state = 'cold'
        )
      ORDER BY t.id
      LIMIT ${args.limit}
    `,
    )
    .map((row) => row.id);
}

export const COLD_ROW_COLUMN_ALLOWANCE_BYTES = 512;

export interface ColdMoveSizeEstimate {
  estimatedBytes: number;
  rowCount: number;
}

export function estimateColdMoveSize(
  db: DbQueryConnection,
  threadId: string,
  keeperIds: readonly string[],
): ColdMoveSizeEstimate {
  const row = db.get<{ row_count: number; data_bytes: number | null }>(sql`
    SELECT COUNT(*) AS row_count, SUM(length(data)) AS data_bytes
    FROM events
    WHERE thread_id = ${threadId}
      AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(keeperIds)}))
  `);
  const rowCount = row?.row_count ?? 0;
  return {
    estimatedBytes:
      (row?.data_bytes ?? 0) + rowCount * COLD_ROW_COLUMN_ALLOWANCE_BYTES,
    rowCount,
  };
}

const COLD_EVENT_SELECT_COLUMNS = EVENT_COLD_COLUMNS.join(", ");

export function iterateColdMoveRows(
  db: DbConnection,
  threadId: string,
  keeperIds: readonly string[],
): IterableIterator<ColdEventRow> {
  return db.$client
    .prepare<[string, string], ColdEventRow>(
      `SELECT ${COLD_EVENT_SELECT_COLUMNS} FROM events
       WHERE thread_id = ?
         AND id NOT IN (SELECT value FROM json_each(?))
       ORDER BY sequence`,
    )
    .iterate(threadId, JSON.stringify(keeperIds));
}

export function serializeColdEventRow(row: ColdEventRow): string {
  const ordered: Record<string, unknown> = {};
  for (const column of EVENT_COLD_COLUMNS) {
    ordered[column] = row[column];
  }
  return JSON.stringify(ordered);
}

export function hashColdEventIds(eventIds: readonly string[]): string {
  return createHash("sha256")
    .update([...eventIds].sort().join("\n"))
    .digest("hex");
}

export function hashColdRowsById(
  db: DbConnection,
  threadId: string,
  eventIds: readonly string[],
): { bodySha256: string; rowCount: number } {
  const hash = createHash("sha256");
  let rowCount = 0;
  const rows = db.$client
    .prepare<[string, string], ColdEventRow>(
      `SELECT ${COLD_EVENT_SELECT_COLUMNS} FROM events
       WHERE thread_id = ?
         AND id IN (SELECT value FROM json_each(?))
       ORDER BY sequence`,
    )
    .iterate(threadId, JSON.stringify(eventIds));
  for (const row of rows) {
    hash.update(serializeColdEventRow(row));
    hash.update("\n");
    rowCount += 1;
  }
  return { bodySha256: hash.digest("hex"), rowCount };
}

export function getThreadEventHighWaterSequence(
  db: DbQueryConnection,
  threadId: string,
): number {
  return getHighWaterMarks(db, [threadId])[threadId] ?? 0;
}

export function runColdTransition<T>(
  db: DbConnection,
  threadId: string,
  fn: () => T,
): T {
  const client = db.$client;
  if (client.inTransaction) {
    throw new Error("Cold transitions cannot run inside a transaction");
  }
  const previousSynchronous = client.pragma("synchronous", {
    simple: true,
  }) as number;
  const previousBusyTimeout = client.pragma("busy_timeout", {
    simple: true,
  }) as number;
  let result: T;
  try {
    client.pragma("synchronous = FULL");
    client.pragma("busy_timeout = 0");
    client.exec("BEGIN IMMEDIATE");
    try {
      result = fn();
      client.exec("COMMIT");
    } catch (error) {
      if (client.inTransaction) {
        client.exec("ROLLBACK");
      }
      throw error;
    }
  } finally {
    client.pragma(`synchronous = ${Number(previousSynchronous)}`);
    client.pragma(`busy_timeout = ${Number(previousBusyTimeout)}`);
  }
  bumpThreadEventRewriteGeneration(threadId);
  return result;
}

export interface ColdSegmentRecord {
  bodySha256: string;
  createdAt: number;
  decompressedBytes: number;
  eventIdsSha256: string;
  fileBytes: number;
  fileSha256: string;
  firstSequence: number;
  formatVersion: number;
  headerBytes: number;
  lastSequence: number;
  path: string;
  rowCount: number;
  segmentId: string;
  threadId: string;
  transformVersions: string;
}

export interface CommitColdMoveArgs {
  eligibility: ColdEligibilityOptions;
  expectedHighWaterSequence: number;
  expectedKeeperIds: readonly string[];
  movedEventIds: readonly string[];
  segment: ColdSegmentRecord;
}

export class ColdTransitionConflictError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Cold transition aborted: ${reason}`);
    this.name = "ColdTransitionConflictError";
    this.reason = reason;
  }
}

export function commitColdMoveInTransaction(
  db: DbConnection,
  args: CommitColdMoveArgs,
): void {
  const threadId = args.segment.threadId;
  const failure = findColdEligibilityFailure(db, threadId, args.eligibility);
  if (failure) {
    throw new ColdTransitionConflictError(failure);
  }
  const keeperIds = selectThreadEventKeeperIds(db, threadId);
  if (
    keeperIds.length !== args.expectedKeeperIds.length ||
    keeperIds.some((id, index) => id !== args.expectedKeeperIds[index])
  ) {
    throw new ColdTransitionConflictError("keeper_set_changed");
  }
  if (
    getThreadEventHighWaterSequence(db, threadId) !==
    args.expectedHighWaterSequence
  ) {
    throw new ColdTransitionConflictError("high_water_changed");
  }
  if (hashColdEventIds(args.movedEventIds) !== args.segment.eventIdsSha256) {
    throw new ColdTransitionConflictError("event_ids_mismatch");
  }
  const rehash = hashColdRowsById(db, threadId, args.movedEventIds);
  if (
    rehash.rowCount !== args.segment.rowCount ||
    rehash.bodySha256 !== args.segment.bodySha256
  ) {
    throw new ColdTransitionConflictError("moved_rows_changed");
  }
  db.insert(eventColdSegments)
    .values({ ...args.segment, lifecycle: "live", endedAt: null })
    .run();
  db.insert(threadEventColdState)
    .values({
      threadId,
      state: "cold",
      liveSegmentId: args.segment.segmentId,
      lastRehydratedAt: null,
    })
    .onConflictDoUpdate({
      target: threadEventColdState.threadId,
      set: { state: "cold", liveSegmentId: args.segment.segmentId },
    })
    .run();
  const deleted = db.$client
    .prepare<[string, string]>(
      `DELETE FROM events
       WHERE thread_id = ?
         AND id IN (SELECT value FROM json_each(?))`,
    )
    .run(threadId, JSON.stringify(args.movedEventIds));
  if (deleted.changes !== args.segment.rowCount) {
    throw new ColdTransitionConflictError("delete_count_mismatch");
  }
}

export interface PreparedRetainedOutputRow {
  eventId: string;
  expiresAt: number;
  outputPath: string;
  value: string;
}

export interface CommitRehydrateArgs {
  now: number;
  retainedOutputs: readonly PreparedRetainedOutputRow[];
  rows: readonly ColdEventRow[];
  segmentId: string;
  threadId: string;
}

export function commitRehydrateInTransaction(
  db: DbConnection,
  args: CommitRehydrateArgs,
): void {
  const state = getThreadEventColdStateRow(db, args.threadId);
  if (state?.state !== "cold" || state.liveSegmentId !== args.segmentId) {
    throw new ColdTransitionConflictError("segment_not_live");
  }
  const sequences = args.rows.map((row) => row.sequence);
  const existing = db.get<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM events
    WHERE thread_id = ${args.threadId}
      AND sequence IN (SELECT value FROM json_each(${JSON.stringify(sequences)}))
  `);
  if ((existing?.count ?? 0) > 0) {
    throw new ColdTransitionConflictError("sequence_exists");
  }
  const environmentExists = db.$client.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM environments WHERE id = ?",
  );
  const environmentPresence = new Map<string, boolean>();
  const insert = db.$client.prepare(
    `INSERT INTO events (${COLD_EVENT_SELECT_COLUMNS})
     VALUES (${EVENT_COLD_COLUMNS.map((column) => `@${column}`).join(", ")})`,
  );
  for (const row of args.rows) {
    if (row.thread_id !== args.threadId) {
      throw new ColdTransitionConflictError("row_thread_mismatch");
    }
    let environmentId = row.environment_id;
    if (environmentId !== null) {
      let present = environmentPresence.get(environmentId);
      if (present === undefined) {
        present = environmentExists.get(environmentId) !== undefined;
        environmentPresence.set(environmentId, present);
      }
      if (!present) {
        environmentId = null;
      }
    }
    insert.run({ ...row, environment_id: environmentId });
  }
  const insertOutput = db.$client.prepare(
    `INSERT INTO retained_event_outputs (event_id, output_path, value, expires_at)
     VALUES (@eventId, @outputPath, @value, @expiresAt)`,
  );
  for (const output of args.retainedOutputs) {
    if (output.expiresAt > args.now) {
      insertOutput.run(output);
    }
  }
  db.update(threadEventColdState)
    .set({ state: "hot", liveSegmentId: null, lastRehydratedAt: args.now })
    .where(eq(threadEventColdState.threadId, args.threadId))
    .run();
  db.update(eventColdSegments)
    .set({ lifecycle: "rehydrated", endedAt: args.now })
    .where(eq(eventColdSegments.segmentId, args.segmentId))
    .run();
}

export function getEventColdSegment(
  db: DbQueryConnection,
  segmentId: string,
): EventColdSegmentRow | null {
  return (
    db
      .select()
      .from(eventColdSegments)
      .where(eq(eventColdSegments.segmentId, segmentId))
      .get() ?? null
  );
}

export function listEventColdSegments(
  db: DbQueryConnection,
  args: { lifecycle?: EventColdSegmentLifecycle } = {},
): EventColdSegmentRow[] {
  const query = db.select().from(eventColdSegments);
  return (
    args.lifecycle
      ? query.where(eq(eventColdSegments.lifecycle, args.lifecycle))
      : query
  )
    .orderBy(eventColdSegments.segmentId)
    .all();
}

export function markOrphanedEventColdSegments(
  db: DbQueryConnection,
  now: number,
): string[] {
  return db
    .all<{ segment_id: string }>(
      sql`
      UPDATE event_cold_segments
      SET lifecycle = 'orphaned', ended_at = ${now}
      WHERE lifecycle = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM threads WHERE threads.id = event_cold_segments.thread_id
        )
      RETURNING segment_id
    `,
    )
    .map((row) => row.segment_id)
    .sort();
}
