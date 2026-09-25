import {
  admitProvisionalSuccessor,
  clearProvisionalSuccessorFence,
  getProvisionalSuccessorFenceState,
  verifyProvisionalSuccessorCheckpoint,
  type ProvisionalSuccessorFenceState,
} from "@bb/db";
import type { Thread } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

export type { ProvisionalSuccessorFenceState };

type FenceDeps = Pick<AppDeps, "db">;

/**
 * Pure fence decision, independent of storage. A thread is fenced exactly
 * when it has been admitted (`epoch` set) and the current epoch has not been
 * verified. `epoch: null` is the default, unadmitted state: every ordinary
 * thread reads as unfenced with zero behavior change.
 *
 * Deliberately coarse: this gates the whole dispatch, not individual native
 * tools. Core has no visibility into what a turn's tool calls will be before
 * it runs one, so the only enforcement point that cannot be bypassed by a
 * plugin, a compromised successor, or a missing hook is upstream of the turn
 * ever starting. A provisional successor that genuinely needs to read and
 * verify its checkpoint does so through the plugin's own read-only surfaces
 * (the SDK, `bb thread show`, etc.), never through a dispatched turn.
 */
export function evaluateProvisionalSuccessorFence(
  state: ProvisionalSuccessorFenceState,
): { fenced: false } | { fenced: true; epoch: number } {
  if (state.epoch === null) return { fenced: false };
  if (state.verifiedEpoch === state.epoch) return { fenced: false };
  return { fenced: true, epoch: state.epoch };
}

/**
 * THE fence check, called unconditionally at the dispatch checkpoint before
 * plugin policy runs. Unlike a `message.dispatch` hook, nothing opts this
 * out: no plugin installed, a plugin that never votes, and a user's
 * Send-now all hit this the same way ordinary writability does. That is the
 * whole point of B1 — a plugin choosing not to register a hook, or a
 * successor sending a message to itself, cannot lift a fence only a
 * verified checkpoint is meant to lift.
 *
 * Conservative choice (open question, see PROPOSAL-M2b B1): this blocks
 * EVERY dispatch on a fenced thread, including one the user initiates
 * directly. A human wanting to intervene on an unverified successor needs a
 * distinct override affordance, not an ordinary send; no such affordance
 * exists yet, so today an admitted-but-unverified thread simply cannot be
 * dispatched into at all except through verification/clearing.
 */
export function ensureProvisionalSuccessorFenceOpen(
  deps: FenceDeps,
  thread: Pick<Thread, "id">,
): void {
  const state = getProvisionalSuccessorFenceState(deps.db, thread.id);
  if (state === null) return;
  const decision = evaluateProvisionalSuccessorFence(state);
  if (!decision.fenced) return;
  throw new ApiError(
    403,
    "provisional_successor_fenced",
    "This thread is a provisional successor and cannot dispatch until its checkpoint is verified",
    { details: { threadId: thread.id, epoch: decision.epoch } },
  );
}

/** Admits `threadId` as a provisional successor, opting it into the fence. */
export function admitThreadAsProvisionalSuccessor(
  deps: FenceDeps,
  input: { threadId: string; epoch: number },
): void {
  admitProvisionalSuccessor(deps.db, input);
}

/**
 * Records checkpoint verification for `epoch`, opening the fence when it
 * matches the thread's current epoch. Returns `false` (fails closed) when
 * the thread has since been re-admitted at a newer epoch: a verification
 * response racing a re-admission must never satisfy the epoch it raced.
 */
export function verifyThreadProvisionalSuccessorCheckpoint(
  deps: FenceDeps,
  input: { threadId: string; epoch: number },
): boolean {
  return verifyProvisionalSuccessorCheckpoint(deps.db, input);
}

/** Releases the fence, returning the thread to ordinary dispatch behavior. */
export function releaseProvisionalSuccessorFence(
  deps: FenceDeps,
  threadId: string,
): void {
  clearProvisionalSuccessorFence(deps.db, threadId);
}
