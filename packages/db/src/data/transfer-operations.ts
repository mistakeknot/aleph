import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { ProjectAttachmentError } from "@bb/domain";
import type { QueuedMessageWaitingOn } from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  queuedThreadMessages,
  threadRedirects,
  threads,
  transferEntries,
  transferEvents,
  transferOperations,
} from "../schema.js";
import {
  QueuedMessageThreadUnavailableError,
  getLastQueuedThreadMessage,
  isThreadRetired,
  transferQueuedThreadMessageInTransaction,
} from "./queued-thread-messages.js";
import { createOrderKeysAfter } from "./order-keys.js";
import type { QueuedThreadMessageRow } from "./queued-thread-messages.js";

export type RetireRefusalReason =
  | "self_transfer"
  | "unknown_thread"
  | "source_deleted"
  | "already_retired"
  | "source_is_retire_target"
  | "target_retired"
  | "thread_not_writable"
  | "transfer_retire_disabled"
  | "attachment_unavailable";

export interface RetireResult {
  operationId: string;
  moved: { id: string; newId: string; originId: string }[];
  pending: { id: string; originId: string }[];
  notForwardable: { id: string; originId: string }[];
}

export interface RetireQueuedThreadMessagesArgs {
  projectId: string;
  sourceThreadId: string;
  targetThreadId: string;
  operationKey: string;
  retireEnabled: boolean;
  admitTarget?: (tx: DbTransaction) => void;
  resolveWaitingOn: (
    source: QueuedThreadMessageRow,
  ) => QueuedMessageWaitingOn | null;
}

export type RetireQueuedThreadMessagesOutcome =
  | {
      kind: "retired";
      operationId: string;
      result: RetireResult;
      movedRows: QueuedThreadMessageRow[];
    }
  | { kind: "replayed"; operationId: string; result: RetireResult }
  | { kind: "refused"; reason: RetireRefusalReason }
  | { kind: "source_has_claims" }
  | { kind: "idempotency_conflict" };

class RetireRolledBack extends Error {
  constructor(readonly reason: RetireRefusalReason) {
    super(reason);
    this.name = "RetireRolledBack";
  }
}

function hashRetireRequest(args: RetireQueuedThreadMessagesArgs) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "retire",
        sourceThreadId: args.sourceThreadId,
        targetThreadId: args.targetThreadId,
      }),
    )
    .digest("hex");
}

function findOperation(
  db: DbQueryConnection,
  projectId: string,
  operationKey: string,
) {
  return db
    .select()
    .from(transferOperations)
    .where(
      and(
        eq(transferOperations.projectId, projectId),
        eq(transferOperations.operationKey, operationKey),
      ),
    )
    .get();
}

function checkRefusal(
  tx: DbQueryConnection,
  args: RetireQueuedThreadMessagesArgs,
): RetireRefusalReason | null {
  if (args.sourceThreadId === args.targetThreadId) return "self_transfer";
  const source = tx
    .select({ projectId: threads.projectId, deletedAt: threads.deletedAt })
    .from(threads)
    .where(eq(threads.id, args.sourceThreadId))
    .get();
  if (!source || source.projectId !== args.projectId) return "unknown_thread";
  if (source.deletedAt !== null) return "source_deleted";
  if (isThreadRetired(tx, args.sourceThreadId)) return "already_retired";
  const isRetireTarget = tx
    .select({ sourceThreadId: threadRedirects.sourceThreadId })
    .from(threadRedirects)
    .where(eq(threadRedirects.successorThreadId, args.sourceThreadId))
    .get();
  if (isRetireTarget) return "source_is_retire_target";
  if (isThreadRetired(tx, args.targetThreadId)) return "target_retired";
  const target = tx
    .select({
      projectId: threads.projectId,
      archivedAt: threads.archivedAt,
      deletedAt: threads.deletedAt,
    })
    .from(threads)
    .where(eq(threads.id, args.targetThreadId))
    .get();
  if (
    !target ||
    target.projectId !== args.projectId ||
    target.archivedAt !== null ||
    target.deletedAt !== null
  ) {
    return "thread_not_writable";
  }
  if (!args.retireEnabled) return "transfer_retire_disabled";
  return null;
}

export function retireQueuedThreadMessages(
  db: DbConnection,
  args: RetireQueuedThreadMessagesArgs,
): RetireQueuedThreadMessagesOutcome {
  const requestHash = hashRetireRequest(args);
  try {
    return db.transaction(
      (tx): RetireQueuedThreadMessagesOutcome => {
        const existing = findOperation(tx, args.projectId, args.operationKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            return { kind: "idempotency_conflict" };
          }
          return {
            kind: "replayed",
            operationId: existing.id,
            result: JSON.parse(existing.resultJson ?? "null") as RetireResult,
          };
        }
        const refusal = checkRefusal(tx, args);
        if (refusal) return { kind: "refused", reason: refusal };
        args.admitTarget?.(tx);

        const rows = tx
          .select()
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.threadId, args.sourceThreadId))
          .orderBy(
            asc(queuedThreadMessages.sortKey),
            asc(queuedThreadMessages.id),
          )
          .all();
        if (rows.some((row) => row.claimedAt !== null)) {
          return { kind: "source_has_claims" };
        }

        const now = Date.now();
        const operationId = `top_${randomUUID()}`;
        tx.insert(transferOperations)
          .values({
            id: operationId,
            projectId: args.projectId,
            operationKey: args.operationKey,
            requestHash,
            kind: "retire",
            sourceThreadId: args.sourceThreadId,
            targetThreadId: args.targetThreadId,
            state: "active",
            createdAt: now,
          })
          .run();

        const result: RetireResult = {
          operationId,
          moved: [],
          pending: [],
          notForwardable: [],
        };
        const movedRows: QueuedThreadMessageRow[] = [];
        const targetKeys = createOrderKeysAfter({
          previousKey:
            getLastQueuedThreadMessage(tx, args.targetThreadId)?.sortKey ??
            null,
          count: rows.filter((row) => row.payloadKind === "inline").length,
        });
        let nextKeyIndex = 0;
        rows.forEach((row, index) => {
          const following = rows[index + 1];
          if (
            row.groupWithNext &&
            row.payloadKind !== "inline" &&
            following?.payloadKind === "inline"
          ) {
            tx.update(queuedThreadMessages)
              .set({ groupWithNext: false, updatedAt: Date.now() })
              .where(eq(queuedThreadMessages.id, row.id))
              .run();
          }
        });
        for (const row of rows) {
          const originId = row.originId ?? row.id;
          if (row.payloadKind !== "inline") {
            tx.insert(transferEntries)
              .values({
                id: `tent_${randomUUID()}`,
                opId: operationId,
                kind: "not_forwardable",
                originId,
                sourceRowId: row.id,
                sourceSortKey: row.sortKey,
                targetRowId: null,
                detail: row.payloadKind,
                state: "terminal",
                updatedAt: now,
              })
              .run();
            result.notForwardable.push({ id: row.id, originId });
            continue;
          }
          const transferred = transferQueuedThreadMessageInTransaction(tx, {
            queuedMessageId: row.id,
            sourceThreadId: args.sourceThreadId,
            targetThreadId: args.targetThreadId,
            sortKey: targetKeys[nextKeyIndex++],
            groupEdgeAlreadyCleared: true,
            sourceRow: row,
            targetVerified: true,
            resolveWaitingOn: args.resolveWaitingOn,
          });
          if (transferred.kind !== "transferred") {
            throw new RetireRolledBack("thread_not_writable");
          }
          tx.insert(transferEntries)
            .values({
              id: `tent_${randomUUID()}`,
              opId: operationId,
              kind: "moved",
              originId,
              sourceRowId: row.id,
              sourceSortKey: row.sortKey,
              targetRowId: transferred.queuedMessage.id,
              detail: null,
              state: "terminal",
              updatedAt: now,
            })
            .run();
          result.moved.push({
            id: row.id,
            newId: transferred.queuedMessage.id,
            originId,
          });
          movedRows.push(transferred.queuedMessage);
        }
        tx.update(transferOperations)
          .set({ resultJson: JSON.stringify(result) })
          .where(eq(transferOperations.id, operationId))
          .run();
        return { kind: "retired", operationId, result, movedRows };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof RetireRolledBack) {
      return { kind: "refused", reason: error.reason };
    }
    if (error instanceof ProjectAttachmentError) {
      return { kind: "refused", reason: "attachment_unavailable" };
    }
    if (error instanceof QueuedMessageThreadUnavailableError) {
      return { kind: "refused", reason: "thread_not_writable" };
    }
    throw error;
  }
}

export function getTransferOperation(
  db: DbQueryConnection,
  operationId: string,
  scope: { projectId?: string } = {},
) {
  const operation = db
    .select()
    .from(transferOperations)
    .where(eq(transferOperations.id, operationId))
    .get();
  if (!operation) return null;
  if (
    scope.projectId !== undefined &&
    operation.projectId !== scope.projectId
  ) {
    return null;
  }
  const entries = db
    .select()
    .from(transferEntries)
    .where(eq(transferEntries.opId, operationId))
    .orderBy(sql`rowid`)
    .all();
  return {
    id: operation.id,
    projectId: operation.projectId,
    kind: operation.kind,
    state: operation.state,
    sourceThreadId: operation.sourceThreadId,
    targetThreadId: operation.targetThreadId,
    ackedAt: operation.ackedAt,
    result:
      operation.resultJson === null
        ? null
        : (JSON.parse(operation.resultJson) as RetireResult),
    entries,
  };
}

export function ackTransferOperation(
  db: DbConnection,
  operationId: string,
  projectId: string,
): boolean {
  return db.transaction(
    (tx) => {
      const operation = tx
        .select({ ackedAt: transferOperations.ackedAt })
        .from(transferOperations)
        .where(
          and(
            eq(transferOperations.id, operationId),
            eq(transferOperations.projectId, projectId),
          ),
        )
        .get();
      if (!operation) return false;
      if (operation.ackedAt === null) {
        tx.update(transferOperations)
          .set({ ackedAt: Date.now() })
          .where(eq(transferOperations.id, operationId))
          .run();
      }
      return true;
    },
    { behavior: "immediate" },
  );
}

export function sweepTransferOperations(db: DbConnection): number {
  return db.transaction(
    (tx) =>
      tx
        .delete(transferOperations)
        .where(
          and(
            isNotNull(transferOperations.ackedAt),
            sql`NOT EXISTS (SELECT 1 FROM thread_redirects WHERE thread_redirects.op_id = ${transferOperations.id})`,
            sql`NOT EXISTS (SELECT 1 FROM transfer_entries WHERE transfer_entries.op_id = ${transferOperations.id} AND transfer_entries.state = 'pending')`,
            sql`NOT EXISTS (SELECT 1 FROM transfer_events WHERE transfer_events.op_id = ${transferOperations.id} AND transfer_events.emitted_at IS NULL)`,
          ),
        )
        .run().changes,
    { behavior: "immediate" },
  );
}

export interface TransferEventRecord {
  eventId: number;
  opId: string;
  entryId: string;
  state: string;
  payload: {
    kind: string;
    state: string;
    rowId: string | null;
    sourceId: string | null;
    origin: string | null;
  };
}

export function drainTransferEvents(
  db: DbConnection,
  deliver: (events: TransferEventRecord[]) => void,
  limit = 500,
): number {
  const rows = db
    .select()
    .from(transferEvents)
    .where(isNull(transferEvents.emittedAt))
    .orderBy(asc(transferEvents.eventId))
    .limit(limit)
    .all();
  if (rows.length === 0) return 0;
  deliver(
    rows.map((row) => ({
      eventId: row.eventId,
      opId: row.opId,
      entryId: row.entryId,
      state: row.state,
      payload: JSON.parse(row.payload) as TransferEventRecord["payload"],
    })),
  );
  const now = Date.now();
  db.transaction(
    (tx) => {
      for (const row of rows) {
        tx.update(transferEvents)
          .set({ emittedAt: now })
          .where(
            and(
              eq(transferEvents.eventId, row.eventId),
              isNull(transferEvents.emittedAt),
            ),
          )
          .run();
      }
    },
    { behavior: "immediate" },
  );
  return rows.length;
}
