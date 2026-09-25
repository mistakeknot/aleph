import { and, eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { idempotentThreadOperations } from "../schema.js";
import { createIdempotentThreadOperationId } from "../ids.js";

export type IdempotentThreadOperationScope = "thread-spawn" | "message-enqueue";
export type IdempotentThreadOperationStatus =
  | "accepted"
  | "completed"
  | "consumed"
  | "failed";

export interface IdempotentThreadOperationRow {
  id: string;
  scope: IdempotentThreadOperationScope;
  idempotencyKey: string;
  status: IdempotentThreadOperationStatus;
  sendAt: number | null;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReserveIdempotentThreadOperationArgs {
  scope: IdempotentThreadOperationScope;
  idempotencyKey: string;
  /** Recorded only on the row's own insert; ignored on every later call. */
  sendAt: number | null;
  now?: number;
}

export interface ReserveIdempotentThreadOperationResult {
  row: IdempotentThreadOperationRow;
  /**
   * True only when THIS call's insert won the unique-index race. A caller
   * that got `false` back found somebody else's row — still `accepted`
   * (still in flight) or already finished — and must not treat itself as the
   * one performing the operation.
   */
  created: boolean;
}

/**
 * Inserts an `accepted` receipt for `(scope, idempotencyKey)` if none exists
 * yet, then always returns the row that now owns that key — the one this
 * call inserted, or the one an earlier call (possibly a still-in-flight
 * attempt, possibly a finished one) already committed. The insert and the
 * read-back are two statements, not one transaction, because the unique
 * index is the actual arbiter: a concurrent insert that loses the race finds
 * nothing to update and the read-back sees the winner's row either way.
 */
export function reserveIdempotentThreadOperation(
  db: DbConnection,
  args: ReserveIdempotentThreadOperationArgs,
): ReserveIdempotentThreadOperationResult {
  const now = args.now ?? Date.now();
  const created =
    db
      .insert(idempotentThreadOperations)
      .values({
        id: createIdempotentThreadOperationId(),
        scope: args.scope,
        idempotencyKey: args.idempotencyKey,
        status: "accepted",
        sendAt: args.sendAt,
        resultJson: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run().changes > 0;
  const row = getIdempotentThreadOperation(db, args);
  if (row === null) {
    throw new Error(
      `Reserved idempotent operation ${args.scope}/${args.idempotencyKey} vanished under its own insert`,
    );
  }
  return { row, created };
}

export function getIdempotentThreadOperation(
  db: DbConnection,
  args: { scope: IdempotentThreadOperationScope; idempotencyKey: string },
): IdempotentThreadOperationRow | null {
  const row = db
    .select()
    .from(idempotentThreadOperations)
    .where(
      and(
        eq(idempotentThreadOperations.scope, args.scope),
        eq(idempotentThreadOperations.idempotencyKey, args.idempotencyKey),
      ),
    )
    .get();
  return row ?? null;
}

export interface CompleteIdempotentThreadOperationArgs {
  scope: IdempotentThreadOperationScope;
  idempotencyKey: string;
  resultJson: string;
  now?: number;
}

/**
 * Moves an `accepted` receipt to `completed` with its result attached. A
 * no-op (returns the row unchanged) once the row is already `completed` or
 * `consumed`, so a duplicate completion notice from a retried caller can
 * never overwrite a result that was already handed out.
 */
export function completeIdempotentThreadOperation(
  db: DbConnection,
  args: CompleteIdempotentThreadOperationArgs,
): IdempotentThreadOperationRow {
  const now = args.now ?? Date.now();
  db.update(idempotentThreadOperations)
    .set({ status: "completed", resultJson: args.resultJson, updatedAt: now })
    .where(
      and(
        eq(idempotentThreadOperations.scope, args.scope),
        eq(idempotentThreadOperations.idempotencyKey, args.idempotencyKey),
        eq(idempotentThreadOperations.status, "accepted"),
      ),
    )
    .run();
  const row = getIdempotentThreadOperation(db, args);
  if (row === null) {
    throw new Error(
      `Completed idempotent operation ${args.scope}/${args.idempotencyKey} has no row`,
    );
  }
  return row;
}

export interface FailIdempotentThreadOperationArgs {
  scope: IdempotentThreadOperationScope;
  idempotencyKey: string;
  errorMessage: string;
  now?: number;
}

/**
 * Moves an `accepted` receipt to `failed`. The row still occupies its key —
 * a genuinely fresh attempt is a policy decision (retry this key, or mint a
 * new one) that belongs to the caller, not to this data function.
 */
export function failIdempotentThreadOperation(
  db: DbConnection,
  args: FailIdempotentThreadOperationArgs,
): IdempotentThreadOperationRow {
  const now = args.now ?? Date.now();
  db.update(idempotentThreadOperations)
    .set({ status: "failed", errorMessage: args.errorMessage, updatedAt: now })
    .where(
      and(
        eq(idempotentThreadOperations.scope, args.scope),
        eq(idempotentThreadOperations.idempotencyKey, args.idempotencyKey),
        eq(idempotentThreadOperations.status, "accepted"),
      ),
    )
    .run();
  const row = getIdempotentThreadOperation(db, args);
  if (row === null) {
    throw new Error(
      `Failed idempotent operation ${args.scope}/${args.idempotencyKey} has no row`,
    );
  }
  return row;
}

/**
 * Moves a `failed` receipt back to `accepted`, in place: same row, same id,
 * same `sendAt` and `createdAt`. A retry after a failure is still the SAME
 * logical operation, so reopening its existing row — rather than reserving a
 * fresh one — is what keeps `sendAt` fixed across a failure/retry cycle, not
 * just across a plain duplicate.
 */
export function reopenFailedIdempotentThreadOperation(
  db: DbConnection,
  args: {
    scope: IdempotentThreadOperationScope;
    idempotencyKey: string;
    now?: number;
  },
): ReserveIdempotentThreadOperationResult {
  const now = args.now ?? Date.now();
  const created =
    db
      .update(idempotentThreadOperations)
      .set({ status: "accepted", errorMessage: null, updatedAt: now })
      .where(
        and(
          eq(idempotentThreadOperations.scope, args.scope),
          eq(idempotentThreadOperations.idempotencyKey, args.idempotencyKey),
          eq(idempotentThreadOperations.status, "failed"),
        ),
      )
      .run().changes > 0;
  const row = getIdempotentThreadOperation(db, args);
  if (row === null) {
    throw new Error(
      `Reopened idempotent operation ${args.scope}/${args.idempotencyKey} has no row`,
    );
  }
  return { row, created };
}

/**
 * Marks a `completed` receipt `consumed` — the caller has acknowledged
 * receiving the result. Purely informational: a later reserve/get against a
 * `consumed` row still replays the same result forever, so a lost ack never
 * turns into a duplicate operation.
 */
export function consumeIdempotentThreadOperation(
  db: DbConnection,
  args: {
    scope: IdempotentThreadOperationScope;
    idempotencyKey: string;
    now?: number;
  },
): IdempotentThreadOperationRow {
  const now = args.now ?? Date.now();
  db.update(idempotentThreadOperations)
    .set({ status: "consumed", updatedAt: now })
    .where(
      and(
        eq(idempotentThreadOperations.scope, args.scope),
        eq(idempotentThreadOperations.idempotencyKey, args.idempotencyKey),
        eq(idempotentThreadOperations.status, "completed"),
      ),
    )
    .run();
  const row = getIdempotentThreadOperation(db, args);
  if (row === null) {
    throw new Error(
      `Consumed idempotent operation ${args.scope}/${args.idempotencyKey} has no row`,
    );
  }
  return row;
}
