import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ProjectAttachmentError } from "@bb/domain";
import type {
  PromptInput,
  QueuedMessageSystemNotice,
  QueuedMessageWaitingOn,
} from "@bb/domain";
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
  ONLINE_QUEUE_MOVE_MAX_ROWS,
  QueuedMessageThreadUnavailableError,
  countQueuedThreadMessagesInTransaction,
  createQueuedThreadMessageInTransaction,
  getLastQueuedThreadMessage,
  isThreadRetired,
  sweepStaleQueuedMessageClaims,
  transferQueuedThreadMessageInTransaction,
} from "./queued-thread-messages.js";
import {
  createOrderKeyAfter,
  createOrderKeyBetween,
  createOrderKeysAfter,
} from "./order-keys.js";
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
  | "source_queue_too_large"
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
  const holdsSlot = tx
    .select({ id: queuedThreadMessages.id })
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.sourceThreadId),
        isNotNull(queuedThreadMessages.forwardSourceRowId),
      ),
    )
    .get();
  if (holdsSlot) return "source_is_retire_target";
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
  if (
    countQueuedThreadMessagesInTransaction(tx, args.sourceThreadId) >
    ONLINE_QUEUE_MOVE_MAX_ROWS
  ) {
    return "source_queue_too_large";
  }
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
          if (row.claimedAt !== null) {
            const slot = createQueuedThreadMessageInTransaction(tx, {
              originId,
              redirect: "direct",
              sortKey: targetKeys[nextKeyIndex++],
              threadVerified: true,
              threadId: args.targetThreadId,
              slotForSourceRowId: row.id,
              content: JSON.parse(row.content) as PromptInput[],
              senderThreadId: row.senderThreadId,
              origin: row.origin,
              originPluginId: row.originPluginId,
              requestedBy:
                row.requestedByInitiator !== null &&
                row.requestedByThreadId !== null
                  ? {
                      initiator: row.requestedByInitiator,
                      senderThreadId: row.requestedByThreadId,
                    }
                  : null,
              model: row.model,
              reasoningLevel: row.reasoningLevel,
              permissionMode: row.permissionMode,
              serviceTier: row.serviceTier,
              waitingOn: null,
              sendAt: row.sendAt,
              payload: { kind: "inline" },
              systemNotice:
                row.systemNotice === null
                  ? null
                  : (JSON.parse(row.systemNotice) as QueuedMessageSystemNotice),
            });
            tx.insert(transferEntries)
              .values({
                id: `tent_${randomUUID()}`,
                opId: operationId,
                kind: "slot",
                originId,
                sourceRowId: row.id,
                sourceSortKey: row.sortKey,
                targetRowId: slot.id,
                detail: null,
                state: "pending",
                updatedAt: now,
              })
              .run();
            result.pending.push({ id: row.id, originId });
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
        tx.insert(threadRedirects)
          .values({
            sourceThreadId: args.sourceThreadId,
            successorThreadId: args.targetThreadId,
            opId: operationId,
          })
          .run();
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

export function listUnemittedTransferEvents(
  db: DbConnection,
  limit = 500,
): TransferEventRecord[] {
  return db
    .select()
    .from(transferEvents)
    .where(isNull(transferEvents.emittedAt))
    .orderBy(asc(transferEvents.eventId))
    .limit(limit)
    .all()
    .map((row) => ({
      eventId: row.eventId,
      opId: row.opId,
      entryId: row.entryId,
      state: row.state,
      payload: JSON.parse(row.payload) as TransferEventRecord["payload"],
    }));
}

export function markTransferEventEmitted(
  db: DbConnection,
  eventId: number,
): boolean {
  return (
    db
      .update(transferEvents)
      .set({ emittedAt: Date.now() })
      .where(
        and(
          eq(transferEvents.eventId, eventId),
          isNull(transferEvents.emittedAt),
        ),
      )
      .run().changes > 0
  );
}

export type AbortRefusalReason =
  | "unknown_operation"
  | "already_aborted"
  | "stale_abort"
  | "successor_retired"
  | "claims_pending"
  | "restore_key_exhausted"
  | "abort_queue_too_large"
  | "attachment_unavailable";

export interface AbortResult {
  operationId: string;
  retirementOperationId: string;
  sourceArchived: boolean;
  returned: { id: string; newId: string; originId: string }[];
  residuals: { originId: string; location: string }[];
}

export interface AbortTransferOperationArgs {
  projectId: string;
  operationId: string;
  expectedRetirementOperationId: string;
  operationKey: string;
  maxReturnedRows?: number;
  resolveWaitingOn: (
    source: QueuedThreadMessageRow,
  ) => QueuedMessageWaitingOn | null;
}

export type AbortTransferOperationOutcome =
  | { kind: "aborted"; operationId: string; result: AbortResult }
  | { kind: "replayed"; operationId: string; result: AbortResult }
  | { kind: "refused"; reason: AbortRefusalReason }
  | { kind: "idempotency_conflict" };

class AbortRolledBack extends Error {
  constructor(readonly reason: AbortRefusalReason) {
    super(reason);
    this.name = "AbortRolledBack";
  }
}

export function chooseRestoreKey(
  existing: readonly string[] | ReadonlySet<string>,
  linkKey: string,
  bound: string | null,
): string | null {
  const taken =
    existing instanceof Set ? existing.has(linkKey) : [...existing].includes(linkKey);
  if (!taken) return linkKey;
  let previous: string | null = null;
  let next: string | null = null;
  for (const key of existing) {
    if (key < linkKey && (previous === null || key > previous)) previous = key;
    if (key > linkKey && (next === null || key < next)) next = key;
  }
  try {
    return createOrderKeyBetween({ previousKey: previous, nextKey: linkKey });
  } catch {
    const ceiling =
      next !== null && bound !== null ? (next < bound ? next : bound) : (next ?? bound);
    try {
      return createOrderKeyBetween({ previousKey: linkKey, nextKey: ceiling });
    } catch {
      return null;
    }
  }
}

function hashAbortRequest(args: AbortTransferOperationArgs) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "abort",
        retirementOperationId: args.operationId,
        expectedRetirementOperationId: args.expectedRetirementOperationId,
      }),
    )
    .digest("hex");
}

function describeResidual(
  tx: DbQueryConnection,
  sourceThreadId: string,
  originId: string,
): string | null {
  const row = tx
    .select({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.originId, originId))
    .limit(1)
    .get();
  if (!row) return "gone";
  if (row.threadId === sourceThreadId) return null;
  const thread = tx
    .select({ deletedAt: threads.deletedAt })
    .from(threads)
    .where(eq(threads.id, row.threadId))
    .get();
  return thread?.deletedAt != null ? `deleted:${row.threadId}` : row.threadId;
}

const ORIGIN_CHUNK_SIZE = 500;

export function abortTransferOperation(
  db: DbConnection,
  args: AbortTransferOperationArgs,
): AbortTransferOperationOutcome {
  const requestHash = hashAbortRequest(args);
  try {
    return db.transaction(
      (tx): AbortTransferOperationOutcome => {
        const existing = findOperation(tx, args.projectId, args.operationKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            return { kind: "idempotency_conflict" };
          }
          return {
            kind: "replayed",
            operationId: existing.id,
            result: JSON.parse(existing.resultJson ?? "null") as AbortResult,
          };
        }
        const retirement = tx
          .select()
          .from(transferOperations)
          .where(eq(transferOperations.id, args.operationId))
          .get();
        if (
          !retirement ||
          retirement.kind !== "retire" ||
          retirement.projectId !== args.projectId
        ) {
          return { kind: "refused", reason: "unknown_operation" };
        }
        if (retirement.state === "aborted") {
          return { kind: "refused", reason: "already_aborted" };
        }
        const sourceId = retirement.sourceThreadId;
        const targetId = retirement.targetThreadId;
        const redirect = tx
          .select()
          .from(threadRedirects)
          .where(eq(threadRedirects.sourceThreadId, sourceId))
          .get();
        const source = tx
          .select({
            archivedAt: threads.archivedAt,
            deletedAt: threads.deletedAt,
          })
          .from(threads)
          .where(eq(threads.id, sourceId))
          .get();
        if (
          args.expectedRetirementOperationId !== retirement.id ||
          !redirect ||
          redirect.opId !== retirement.id ||
          !source ||
          source.deletedAt !== null
        ) {
          return { kind: "refused", reason: "stale_abort" };
        }
        const target = tx
          .select({ deletedAt: threads.deletedAt })
          .from(threads)
          .where(eq(threads.id, targetId))
          .get();
        const targetLive = target !== undefined && target.deletedAt === null;
        if (
          targetLive &&
          tx
            .select({ sourceThreadId: threadRedirects.sourceThreadId })
            .from(threadRedirects)
            .where(eq(threadRedirects.sourceThreadId, targetId))
            .get()
        ) {
          return { kind: "refused", reason: "successor_retired" };
        }

        const retirementEntries = tx
          .select()
          .from(transferEntries)
          .where(eq(transferEntries.opId, retirement.id))
          .orderBy(sql`rowid`)
          .all();
        const owned = retirementEntries.filter(
          (entry) =>
            entry.kind === "moved" ||
            entry.kind === "redirected" ||
            (entry.kind === "slot" && entry.state === "forwarded"),
        );
        const ownedOrigins = owned.flatMap((entry) =>
          entry.originId === null ? [] : [entry.originId],
        );

        const sourceClaimed = tx
          .select({ id: queuedThreadMessages.id })
          .from(queuedThreadMessages)
          .where(
            and(
              eq(queuedThreadMessages.threadId, sourceId),
              isNotNull(queuedThreadMessages.claimedAt),
            ),
          )
          .get();
        const pendingEntry = retirementEntries.some(
          (entry) => entry.state === "pending",
        );
        const ownedClaimed =
          targetLive &&
          ownedOrigins.some(
            (_origin, index) =>
              index % ORIGIN_CHUNK_SIZE === 0 &&
              tx
                .select({ id: queuedThreadMessages.id })
                .from(queuedThreadMessages)
                .where(
                  and(
                    eq(queuedThreadMessages.threadId, targetId),
                    isNotNull(queuedThreadMessages.claimedAt),
                    inArray(
                      queuedThreadMessages.originId,
                      ownedOrigins.slice(index, index + ORIGIN_CHUNK_SIZE),
                    ),
                  ),
                )
                .get() !== undefined,
          );
        if (sourceClaimed || pendingEntry || ownedClaimed) {
          return { kind: "refused", reason: "claims_pending" };
        }

        const now = Date.now();
        const abortId = `top_${randomUUID()}`;
        tx.insert(transferOperations)
          .values({
            id: abortId,
            projectId: args.projectId,
            operationKey: args.operationKey,
            requestHash,
            kind: "abort",
            sourceThreadId: sourceId,
            targetThreadId: targetId,
            state: "active",
            createdAt: now,
          })
          .run();

        const result: AbortResult = {
          operationId: abortId,
          retirementOperationId: retirement.id,
          sourceArchived: source.archivedAt !== null,
          returned: [],
          residuals: [],
        };
        const returnedOrigins = new Set<string>();
        const sourceKeys = new Set(
          tx
            .select({ sortKey: queuedThreadMessages.sortKey })
            .from(queuedThreadMessages)
            .where(eq(queuedThreadMessages.threadId, sourceId))
            .all()
            .map((row) => row.sortKey),
        );

        const ownedRowsOnTarget: QueuedThreadMessageRow[] = [];
        if (targetLive) {
          for (
            let index = 0;
            index < ownedOrigins.length;
            index += ORIGIN_CHUNK_SIZE
          ) {
            ownedRowsOnTarget.push(
              ...tx
                .select()
                .from(queuedThreadMessages)
                .where(
                  and(
                    eq(queuedThreadMessages.threadId, targetId),
                    isNull(queuedThreadMessages.claimedAt),
                    inArray(
                      queuedThreadMessages.originId,
                      ownedOrigins.slice(index, index + ORIGIN_CHUNK_SIZE),
                    ),
                  ),
                )
                .all(),
            );
          }
          ownedRowsOnTarget.sort((left, right) =>
            left.sortKey !== right.sortKey
              ? left.sortKey < right.sortKey
                ? -1
                : 1
              : left.id < right.id
                ? -1
                : 1,
          );
        }
        const rowByOrigin = new Map(
          ownedRowsOnTarget.map((row) => [row.originId ?? row.id, row]),
        );
        const keyed = owned
          .filter(
            (entry) =>
              entry.kind !== "redirected" &&
              entry.sourceSortKey !== null &&
              entry.originId !== null && rowByOrigin.has(entry.originId),
          )
          .sort((left, right) => {
            const a = left.sourceSortKey ?? "";
            const b = right.sourceSortKey ?? "";
            if (a !== b) return a < b ? -1 : 1;
            return (left.sourceRowId ?? "") < (right.sourceRowId ?? "") ? -1 : 1;
          });
        const redirectedOrigins = new Set(
          owned.flatMap((entry) =>
            entry.kind === "redirected" && entry.originId !== null
              ? [entry.originId]
              : [],
          ),
        );
        const unkeyed = ownedRowsOnTarget.filter(
          (row) => row.originId !== null && redirectedOrigins.has(row.originId),
        );
        if (
          args.maxReturnedRows !== undefined &&
          keyed.length + unkeyed.length > args.maxReturnedRows
        ) {
          throw new AbortRolledBack("abort_queue_too_large");
        }

        const giveBack = (row: QueuedThreadMessageRow, sortKey: string) => {
          const moved = transferQueuedThreadMessageInTransaction(tx, {
            queuedMessageId: row.id,
            sourceThreadId: targetId,
            targetThreadId: sourceId,
            sortKey,
            sourceRow: row,
            targetVerified: true,
            resolveWaitingOn: args.resolveWaitingOn,
          });
          if (moved.kind !== "transferred") {
            throw new AbortRolledBack("claims_pending");
          }
          sourceKeys.add(sortKey);
          const originId = row.originId ?? row.id;
          returnedOrigins.add(originId);
          tx.insert(transferEntries)
            .values({
              id: `tent_${randomUUID()}`,
              opId: abortId,
              kind: "returned",
              originId,
              sourceRowId: row.id,
              sourceSortKey: row.sortKey,
              targetRowId: moved.queuedMessage.id,
              detail: null,
              state: "terminal",
              updatedAt: now,
            })
            .run();
          result.returned.push({
            id: row.id,
            newId: moved.queuedMessage.id,
            originId,
          });
        };

        keyed.forEach((entry, index) => {
          const row = entry.originId === null ? undefined : rowByOrigin.get(entry.originId);
          if (!row || entry.sourceSortKey === null) return;
          const bound = keyed[index + 1]?.sourceSortKey ?? null;
          const key = chooseRestoreKey(sourceKeys, entry.sourceSortKey, bound);
          if (key === null) throw new AbortRolledBack("restore_key_exhausted");
          giveBack(row, key);
        });
        for (const row of unkeyed) {
          const last = [...sourceKeys].reduce<string | null>(
            (greatest, key) => (greatest === null || key > greatest ? key : greatest),
            null,
          );
          giveBack(
            row,
            last === null
              ? createOrderKeyBetween({ previousKey: null, nextKey: null })
              : createOrderKeyAfter({ previousKey: last }),
          );
        }

        for (const originId of ownedOrigins) {
          if (returnedOrigins.has(originId)) continue;
          const location = describeResidual(tx, sourceId, originId);
          if (location === null) continue;
          tx.insert(transferEntries)
            .values({
              id: `tent_${randomUUID()}`,
              opId: abortId,
              kind: "residual",
              originId,
              sourceRowId: null,
              sourceSortKey: null,
              targetRowId: null,
              detail: location,
              state: "terminal",
              updatedAt: now,
            })
            .run();
          result.residuals.push({ originId, location });
        }

        tx.delete(threadRedirects)
          .where(eq(threadRedirects.sourceThreadId, sourceId))
          .run();
        tx.update(transferOperations)
          .set({ state: "aborted" })
          .where(eq(transferOperations.id, retirement.id))
          .run();
        tx.update(transferOperations)
          .set({ state: "done", resultJson: JSON.stringify(result) })
          .where(eq(transferOperations.id, abortId))
          .run();
        return { kind: "aborted", operationId: abortId, result };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof AbortRolledBack) {
      return { kind: "refused", reason: error.reason };
    }
    if (error instanceof ProjectAttachmentError) {
      return { kind: "refused", reason: "attachment_unavailable" };
    }
    throw error;
  }
}

export function releaseAllWorkerClaimsOffline(db: DbConnection): {
  released: number;
  threadIds: string[];
} {
  return sweepStaleQueuedMessageClaims(db, {
    claimedBefore: Number.MAX_SAFE_INTEGER,
    protectedClaimTokens: [],
  });
}

export interface DowngradeReadiness {
  slots: number;
  pendingEntries: number;
  unemittedEvents: number;
  redirects: number;
  nullOrigins: number;
  unackedReceipts: number;
  ready: boolean;
}

function countRows(db: DbConnection, query: string): number {
  const row = db.$client.prepare(query).get() as { n: number };
  return row.n;
}

export function getDowngradeReadiness(db: DbConnection): DowngradeReadiness {
  const slots = countRows(
    db,
    "SELECT count(*) AS n FROM queued_thread_messages WHERE forward_source_row_id IS NOT NULL",
  );
  const pendingEntries = countRows(
    db,
    "SELECT count(*) AS n FROM transfer_entries WHERE state = 'pending'",
  );
  const unemittedEvents = countRows(
    db,
    "SELECT count(*) AS n FROM transfer_events WHERE emitted_at IS NULL",
  );
  const redirects = countRows(db, "SELECT count(*) AS n FROM thread_redirects");
  const nullOrigins = countRows(
    db,
    "SELECT count(*) AS n FROM queued_thread_messages WHERE origin_id IS NULL",
  );
  const unackedReceipts = countRows(
    db,
    "SELECT count(*) AS n FROM transfer_operations WHERE acked_at IS NULL",
  );
  return {
    slots,
    pendingEntries,
    unemittedEvents,
    redirects,
    nullOrigins,
    unackedReceipts,
    ready:
      slots +
        pendingEntries +
        unemittedEvents +
        redirects +
        nullOrigins +
        unackedReceipts ===
      0,
  };
}
