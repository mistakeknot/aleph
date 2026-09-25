import { z } from "zod";
import {
  completeIdempotentThreadOperation,
  consumeIdempotentThreadOperation,
  failIdempotentThreadOperation,
  reopenFailedIdempotentThreadOperation,
  reserveIdempotentThreadOperation,
  type IdempotentThreadOperationRow,
  type IdempotentThreadOperationScope,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";

/**
 * Durable idempotent reconciliation for thread spawn and message enqueue.
 *
 * A caller (the SDK, a plugin, a CLI retry loop) that loses the response to a
 * spawn or an enqueue and resubmits the SAME request with the SAME
 * caller-supplied `idempotencyKey` must land on the ONE logical operation the
 * first attempt started — not a duplicate thread, not a duplicate queued
 * message, and not a `sendAt` that drifted to whenever the retry happened to
 * arrive. `apps/server/src/services/threads/idempotent-thread-operations`
 * (in `@bb/db`) is the durable ledger this reconciles against; this module is
 * the policy that decides what a caller should do with what it finds there.
 *
 * The three receipt states the B3 proposal asks for map onto the ledger's
 * `status` column directly: `accepted` is "the server durably recorded this
 * request and has not yet committed a result" (in flight, from a fresh
 * process's point of view — a restart cannot tell an in-flight accepted
 * attempt apart from one whose process died, which is why `in-flight` is
 * reported rather than silently retried); `completed`/`consumed` is
 * "delivered" and "delivered and acknowledged"; `failed` is a terminal
 * outcome a caller may explicitly reopen.
 */
export interface ReconcileIdempotentThreadOperationArgs<TResult> {
  scope: IdempotentThreadOperationScope;
  idempotencyKey: string;
  /** Epoch ms this attempt asked the operation to run at, if any. */
  sendAt: number | null;
  resultSchema: z.ZodType<TResult>;
}

export type IdempotentThreadOperationOutcome<TResult> =
  | { kind: "new"; sendAt: number | null }
  | { kind: "in-flight"; sendAt: number | null }
  | { kind: "replay"; result: TResult; sendAt: number | null }
  | { kind: "failed"; errorMessage: string | null; sendAt: number | null };

/**
 * Reserves or reads back the receipt for `(scope, idempotencyKey)`.
 *
 * - `new`: no prior attempt exists (or this call's insert won the race). The
 *   caller performs the spawn/enqueue and MUST call
 *   {@link recordIdempotentThreadOperationSuccess} or
 *   {@link recordIdempotentThreadOperationFailure} with the same key when it
 *   finishes, so a later retry has something durable to reconcile against.
 * - `in-flight`: another attempt already claimed this key and has not
 *   finished. The caller must NOT start a second operation; it should wait
 *   (event-backed, per B4) and re-reconcile rather than proceed.
 * - `replay`: the operation already finished successfully. The caller
 *   returns `result` as-is — same thread id, same queued-message id, same
 *   `sendAt` — regardless of what THIS attempt's request carried.
 * - `failed`: the operation already finished unsuccessfully. The caller
 *   decides whether to reopen the SAME key (preserving `sendAt`) via
 *   {@link reopenIdempotentThreadOperation}, which is a distinct, explicit
 *   step rather than something a plain reconcile does silently.
 */
export function reconcileIdempotentThreadOperation<TResult>(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: ReconcileIdempotentThreadOperationArgs<TResult>,
): IdempotentThreadOperationOutcome<TResult> {
  const { row, created } = reserveIdempotentThreadOperation(deps.db, {
    scope: args.scope,
    idempotencyKey: args.idempotencyKey,
    sendAt: args.sendAt,
  });
  return outcomeFromRow(row, created, args.resultSchema);
}

function outcomeFromRow<TResult>(
  row: IdempotentThreadOperationRow,
  created: boolean,
  resultSchema: z.ZodType<TResult>,
): IdempotentThreadOperationOutcome<TResult> {
  switch (row.status) {
    case "accepted":
      // `created` is the ONLY thing that tells the two apart: an `accepted`
      // row looks identical whether this call just inserted it or an earlier,
      // still-unfinished attempt did.
      return created
        ? { kind: "new", sendAt: row.sendAt }
        : { kind: "in-flight", sendAt: row.sendAt };
    case "completed":
    case "consumed":
      return {
        kind: "replay",
        result: resultSchema.parse(JSON.parse(row.resultJson ?? "null")),
        sendAt: row.sendAt,
      };
    case "failed":
      return {
        kind: "failed",
        errorMessage: row.errorMessage,
        sendAt: row.sendAt,
      };
  }
}

export function recordIdempotentThreadOperationSuccess<TResult>(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: {
    scope: IdempotentThreadOperationScope;
    idempotencyKey: string;
    result: TResult;
  },
): void {
  completeIdempotentThreadOperation(deps.db, {
    scope: args.scope,
    idempotencyKey: args.idempotencyKey,
    resultJson: JSON.stringify(args.result),
  });
}

export function recordIdempotentThreadOperationFailure(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: {
    scope: IdempotentThreadOperationScope;
    idempotencyKey: string;
    errorMessage: string;
  },
): void {
  failIdempotentThreadOperation(deps.db, {
    scope: args.scope,
    idempotencyKey: args.idempotencyKey,
    errorMessage: args.errorMessage,
  });
}

/**
 * Reopens a `failed` receipt so its key can be retried — same row, same
 * `sendAt`. Returns `null` if the row is not `failed` (a concurrent reopen
 * won, or the caller reconciled against a stale read); the caller should
 * reconcile again rather than assume it owns the retry.
 */
export function reopenIdempotentThreadOperation(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { scope: IdempotentThreadOperationScope; idempotencyKey: string },
): { kind: "new"; sendAt: number | null } | null {
  const { row, created } = reopenFailedIdempotentThreadOperation(deps.db, args);
  return created ? { kind: "new", sendAt: row.sendAt } : null;
}

export function acknowledgeIdempotentThreadOperation(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { scope: IdempotentThreadOperationScope; idempotencyKey: string },
): void {
  consumeIdempotentThreadOperation(deps.db, args);
}
