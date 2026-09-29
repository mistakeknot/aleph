import {
  cancelRelayForHostTargetsInTransaction,
  cancelRelayForTargetInTransaction,
  insertRelayTarget,
  isActiveHostId,
  isLiveThreadId,
  listRelayTargetDetailsForHost,
  listRelayTargetsForHost,
  recordGateAssertionUse,
  sweepExpiredGateAssertionUses,
  type DbTransaction,
  type RelayCancellationResult,
} from "@bb/db";
import type { HostRelayTargetsResponse } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  humanSessionRequired,
  verifyHumanAssertion,
  type HumanAssertionDeps,
  type HumanAssertionRequest,
  type VerifiedHumanAssertion,
} from "./human-assertion.js";

export const RELAY_TARGET_REMOVED_REASON = "target_removed";
export const RELAY_HOST_TARGETS_REMOVED_REASON = "host_targets_removed";

type RelayManagementDeps = Pick<AppDeps, "db" | "hub">;

function requireHost(tx: DbTransaction, hostId: string): void {
  if (!isActiveHostId(tx, hostId)) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
}

function consumeAssertion(
  tx: DbTransaction,
  assertion: VerifiedHumanAssertion,
  now: number,
): void {
  sweepExpiredGateAssertionUses(tx, now);
  const fresh = recordGateAssertionUse(tx, {
    jti: assertion.jti,
    expiresAt: assertion.expiresAtMs,
  });
  if (!fresh) throw humanSessionRequired();
}

export function notifyRelayCancellation(
  deps: { hub: Pick<AppDeps["hub"], "notifyThread"> },
  result: RelayCancellationResult,
): void {
  for (const threadId of result.affectedThreadIds) {
    deps.hub.notifyThread(threadId, ["queue-changed"]);
  }
}

export async function listRelayTargetsForHuman(
  deps: RelayManagementDeps,
  context: HumanAssertionRequest,
  assertionDeps: HumanAssertionDeps,
  hostId: string,
): Promise<HostRelayTargetsResponse> {
  const assertion = await verifyHumanAssertion(context, assertionDeps);
  return deps.db.transaction(
    (tx) => {
      consumeAssertion(tx, assertion, (assertionDeps.now ?? Date.now)());
      requireHost(tx, hostId);
      return { targets: listRelayTargetDetailsForHost(tx, hostId) };
    },
    { behavior: "immediate" },
  );
}

export async function addRelayTargetForHuman(
  deps: RelayManagementDeps,
  context: HumanAssertionRequest,
  assertionDeps: HumanAssertionDeps,
  args: { hostId: string; threadId: string },
): Promise<void> {
  const assertion = await verifyHumanAssertion(context, assertionDeps);
  const now = (assertionDeps.now ?? Date.now)();
  deps.db.transaction(
    (tx) => {
      consumeAssertion(tx, assertion, now);
      requireHost(tx, args.hostId);
      if (!isLiveThreadId(tx, args.threadId)) {
        throw new ApiError(404, "thread_not_found", "Thread not found");
      }
      insertRelayTarget(tx, {
        hostId: args.hostId,
        threadId: args.threadId,
        createdByUserId: assertion.binding.ownerUserId,
        now,
      });
    },
    { behavior: "immediate" },
  );
}

export async function removeRelayTargetForHuman(
  deps: RelayManagementDeps,
  context: HumanAssertionRequest,
  assertionDeps: HumanAssertionDeps,
  args: { hostId: string; threadId: string },
): Promise<void> {
  const assertion = await verifyHumanAssertion(context, assertionDeps);
  const result = deps.db.transaction(
    (tx) => {
      consumeAssertion(tx, assertion, (assertionDeps.now ?? Date.now)());
      requireHost(tx, args.hostId);
      return cancelRelayForTargetInTransaction(
        tx,
        args.hostId,
        args.threadId,
        RELAY_TARGET_REMOVED_REASON,
      );
    },
    { behavior: "immediate" },
  );
  notifyRelayCancellation(deps, result);
}

export function listOwnRelayTargets(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): { createdAt: number; threadId: string }[] {
  return listRelayTargetsForHost(deps.db, hostId).map((row) => ({
    threadId: row.threadId,
    createdAt: row.createdAt,
  }));
}

export function removeOwnRelayTargets(
  deps: RelayManagementDeps,
  args: { hostId: string; threadId?: string },
): { cancelled: number; removed: number } {
  const result = deps.db.transaction(
    (tx) =>
      args.threadId === undefined
        ? cancelRelayForHostTargetsInTransaction(
            tx,
            args.hostId,
            RELAY_HOST_TARGETS_REMOVED_REASON,
          )
        : cancelRelayForTargetInTransaction(
            tx,
            args.hostId,
            args.threadId,
            RELAY_TARGET_REMOVED_REASON,
          ),
    { behavior: "immediate" },
  );
  notifyRelayCancellation(deps, result);
  return {
    removed: result.removedTargets,
    cancelled: result.cancelledQueuedMessages + result.claimedAttempts,
  };
}
