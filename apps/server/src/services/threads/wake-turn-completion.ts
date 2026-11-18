import type { HeldTurnCompletionStatus } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { runThreadLifecycleTransaction } from "./lifecycle/run.js";
import { recordSettledWakeOutcome } from "./wake-turn-outcome.js";

function snapshotErrorCategory(
  error: unknown,
): "SqliteError" | "SnapshotError" {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current.name === "SqliteError") return "SqliteError";
    current = current.cause;
  }
  return "SnapshotError";
}

export function applyWakeTurnCompletion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string; turnId: string; status: HeldTurnCompletionStatus },
) {
  try {
    recordSettledWakeOutcome(deps, {
      threadId: args.threadId,
      snapshotTurnId: args.turnId,
    });
  } catch (error) {
    deps.logger.warn(
      {
        threadId: args.threadId,
        turnId: args.turnId,
        errorName: snapshotErrorCategory(error),
      },
      "Wake outcome snapshot unavailable during turn settlement",
    );
  }
  return runThreadLifecycleTransaction(deps, args.threadId, {
    type: "turn.completed",
    turnId: args.turnId,
    status: args.status,
  });
}
