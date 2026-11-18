import {
  requireThreadEventScopeTurnId,
  type ThreadEvent,
  type ThreadStatus,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../src/types.js";
import { applyWakeTurnCompletion } from "../../src/services/threads/wake-turn-completion.js";

// Compatibility for Aleph's telemetry assertions; the persisted machine is the authority.
export function applyTurnCompletedEvent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    afterIdle: (() => Promise<void>) | null;
    payload: Extract<ThreadEvent, { type: "turn/completed" }>;
  },
): { kind: "deferred" } | { kind: "settled"; nextStatus: ThreadStatus | null } {
  const outcome = applyWakeTurnCompletion(deps, {
    threadId: args.payload.threadId,
    turnId: requireThreadEventScopeTurnId(args.payload),
    status: args.payload.status,
  });
  if (outcome.refusal !== null)
    throw new Error(`Completion refused: ${outcome.refusal}`);
  const ended = outcome.effects.find((effect) => effect.kind === "turn-ended");
  if (ended?.kind === "turn-ended" && ended.disposition === "held")
    return { kind: "deferred" };
  if (ended?.kind !== "turn-ended" || ended.disposition === "ignored") {
    return { kind: "settled", nextStatus: null };
  }
  return { kind: "settled", nextStatus: outcome.thread?.status ?? null };
}
