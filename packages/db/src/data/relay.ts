import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import {
  projectAttachments,
  projectAttachmentThreads,
  queuedThreadMessages,
  relayMessages,
  relayTargets,
} from "../schema.js";
import { deleteUnclaimedQueuedThreadMessageInTransaction } from "./queued-thread-messages.js";

export const RELAY_CLEANUP_CLAIM_MS = 2 * 60_000;

export type RelayMessageRow = typeof relayMessages.$inferSelect;
export type RelayTargetRow = typeof relayTargets.$inferSelect;

export interface RelayCleanupClaimOptions {
  cancelReason?: string;
  now?: number;
}

export interface RelayCancellationResult {
  affectedThreadIds: string[];
  cancelledQueuedMessages: number;
  claimedAttempts: number;
  removedTargets: number;
}

export function getRelayTarget(
  db: DbQueryConnection,
  hostId: string,
  threadId: string,
): RelayTargetRow | null {
  return (
    db
      .select()
      .from(relayTargets)
      .where(
        and(
          eq(relayTargets.hostId, hostId),
          eq(relayTargets.threadId, threadId),
        ),
      )
      .get() ?? null
  );
}

export function insertRelayTarget(
  db: DbQueryConnection,
  input: {
    hostId: string;
    threadId: string;
    createdByUserId: string;
    now?: number;
  },
): void {
  db.insert(relayTargets)
    .values({
      hostId: input.hostId,
      threadId: input.threadId,
      createdByUserId: input.createdByUserId,
      createdAt: input.now ?? Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export function getRelayMessage(
  db: DbQueryConnection,
  id: string,
): RelayMessageRow | null {
  return (
    db.select().from(relayMessages).where(eq(relayMessages.id, id)).get() ??
    null
  );
}

export function claimRelayAttemptCleanupInTransaction(
  tx: DbTransaction,
  row: Pick<RelayMessageRow, "id" | "leaseToken">,
  options: RelayCleanupClaimOptions = {},
): RelayMessageRow | null {
  if (row.leaseToken === null) return null;
  const now = options.now ?? Date.now();
  const set: Partial<typeof relayMessages.$inferInsert> = {
    status: "cleaning",
    cleanupToken: randomUUID(),
    cleanupExpiresAt: now + RELAY_CLEANUP_CLAIM_MS,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: now,
  };
  if (options.cancelReason !== undefined) {
    set.cancelReason = options.cancelReason;
  }
  return (
    tx
      .update(relayMessages)
      .set(set)
      .where(
        and(
          eq(relayMessages.id, row.id),
          eq(relayMessages.status, "reserved"),
          eq(relayMessages.leaseToken, row.leaseToken),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function takeOverRelayAttemptCleanupInTransaction(
  tx: DbTransaction,
  row: Pick<RelayMessageRow, "id" | "cleanupToken">,
  options: RelayCleanupClaimOptions = {},
): RelayMessageRow | null {
  if (row.cleanupToken === null) return null;
  const now = options.now ?? Date.now();
  const set: Partial<typeof relayMessages.$inferInsert> = {
    cleanupToken: randomUUID(),
    cleanupExpiresAt: now + RELAY_CLEANUP_CLAIM_MS,
    updatedAt: now,
  };
  if (options.cancelReason !== undefined) {
    set.cancelReason = options.cancelReason;
  }
  return (
    tx
      .update(relayMessages)
      .set(set)
      .where(
        and(
          eq(relayMessages.id, row.id),
          eq(relayMessages.status, "cleaning"),
          eq(relayMessages.cleanupToken, row.cleanupToken),
          sql`${relayMessages.cleanupExpiresAt} <= ${now}`,
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function completeRelayAttemptCleanupInTransaction(
  tx: DbTransaction,
  args: { id: string; cleanupToken: string; now?: number },
): RelayMessageRow | null {
  const now = args.now ?? Date.now();
  const existing = tx
    .select()
    .from(relayMessages)
    .where(
      and(
        eq(relayMessages.id, args.id),
        eq(relayMessages.status, "cleaning"),
        eq(relayMessages.cleanupToken, args.cleanupToken),
      ),
    )
    .get();
  if (!existing) return null;
  return (
    tx
      .update(relayMessages)
      .set({
        status: existing.cancelReason === null ? "failed" : "cancelled",
        cleanupToken: null,
        cleanupExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(relayMessages.id, args.id),
          eq(relayMessages.status, "cleaning"),
          eq(relayMessages.cleanupToken, args.cleanupToken),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function claimUnownedRelayAttachmentsForDeletionInTransaction(
  tx: DbTransaction,
  args: { relayMessageId: string; relayAttemptToken: string; now?: number },
): number {
  const now = args.now ?? Date.now();
  return tx
    .update(projectAttachments)
    .set({ deletionClaimedAt: now })
    .where(
      and(
        eq(projectAttachments.relayMessageId, args.relayMessageId),
        eq(projectAttachments.relayAttemptToken, args.relayAttemptToken),
        isNull(projectAttachments.deletionClaimedAt),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(projectAttachmentThreads)
            .where(
              eq(projectAttachmentThreads.attachmentId, projectAttachments.id),
            ),
        ),
      ),
    )
    .returning({ id: projectAttachments.id })
    .all().length;
}

interface RelayCancellationScope {
  hostId: string;
  threadId: string | null;
}

function cancelRelayInTransaction(
  tx: DbTransaction,
  scope: RelayCancellationScope,
  reason: string,
): RelayCancellationResult {
  const now = Date.now();
  const affectedThreadIds = new Set<string>();

  const removedTargets = tx
    .delete(relayTargets)
    .where(
      scope.threadId === null
        ? eq(relayTargets.hostId, scope.hostId)
        : and(
            eq(relayTargets.hostId, scope.hostId),
            eq(relayTargets.threadId, scope.threadId),
          ),
    )
    .returning({ threadId: relayTargets.threadId })
    .all();
  for (const target of removedTargets) affectedThreadIds.add(target.threadId);

  const queuedRows = tx
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        sql`json_extract(${queuedThreadMessages.relayProvenance}, '$.hostId') = ${scope.hostId}`,
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
        scope.threadId === null
          ? undefined
          : eq(queuedThreadMessages.threadId, scope.threadId),
      ),
    )
    .all();
  for (const row of queuedRows) {
    deleteUnclaimedQueuedThreadMessageInTransaction(tx, row, now);
    affectedThreadIds.add(row.threadId);
  }
  if (queuedRows.length > 0) {
    tx.update(relayMessages)
      .set({ status: "cancelled", cancelReason: reason, updatedAt: now })
      .where(
        and(
          inArray(
            relayMessages.queuedMessageId,
            queuedRows.map((row) => row.id),
          ),
          eq(relayMessages.status, "accepted"),
        ),
      )
      .run();
  }

  const messageScope =
    scope.threadId === null
      ? eq(relayMessages.hostId, scope.hostId)
      : and(
          eq(relayMessages.hostId, scope.hostId),
          eq(relayMessages.threadId, scope.threadId),
        );

  let claimedAttempts = 0;
  const reserved = tx
    .select()
    .from(relayMessages)
    .where(and(messageScope, eq(relayMessages.status, "reserved")))
    .all();
  for (const row of reserved) {
    const leaseToken = row.leaseToken;
    const claimed = claimRelayAttemptCleanupInTransaction(tx, row, {
      cancelReason: reason,
      now,
    });
    if (!claimed || leaseToken === null) continue;
    claimedAttempts += 1;
    affectedThreadIds.add(row.threadId);
    claimUnownedRelayAttachmentsForDeletionInTransaction(tx, {
      relayMessageId: row.id,
      relayAttemptToken: leaseToken,
      now,
    });
  }

  tx.update(relayMessages)
    .set({ cancelReason: reason, updatedAt: now })
    .where(
      and(
        messageScope,
        eq(relayMessages.status, "cleaning"),
        isNull(relayMessages.cancelReason),
      ),
    )
    .run();

  return {
    affectedThreadIds: [...affectedThreadIds],
    cancelledQueuedMessages: queuedRows.length,
    claimedAttempts,
    removedTargets: removedTargets.length,
  };
}

export function cancelRelayForHostInTransaction(
  tx: DbTransaction,
  hostId: string,
  reason: string,
): RelayCancellationResult {
  return cancelRelayInTransaction(tx, { hostId, threadId: null }, reason);
}

export function cancelRelayForHostTargetsInTransaction(
  tx: DbTransaction,
  hostId: string,
  reason: string,
): RelayCancellationResult {
  return cancelRelayInTransaction(tx, { hostId, threadId: null }, reason);
}

export function cancelRelayForTargetInTransaction(
  tx: DbTransaction,
  hostId: string,
  threadId: string,
  reason: string,
): RelayCancellationResult {
  return cancelRelayInTransaction(tx, { hostId, threadId }, reason);
}
