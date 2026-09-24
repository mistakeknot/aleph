import { z } from "zod";
import { getStoredTurnRequestEventForTurn } from "@bb/db";
import type { ThreadEventTurnStatus } from "@bb/domain";
import type {
  MessageDispatchWaitDecision,
  DispatchAttemptKind,
} from "./dispatch-hooks.js";
import {
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  runMessageDispatchHookPass,
} from "./dispatch-hooks.js";
import {
  intendedThreadEnvironmentIntent,
  intendedThreadHostId,
} from "./dispatch-attempt.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import { buildExecutionOptions } from "./thread-commands.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import type { PromptInput, Thread } from "@bb/domain";

const parentWakeNotifySettingValues = ["all", "changed", "quiet"] as const;
export const parentWakeNotifySettingSchema = z.enum(
  parentWakeNotifySettingValues,
);
export type ParentWakeNotifySetting = z.infer<
  typeof parentWakeNotifySettingSchema
>;

export const DEFAULT_PARENT_WAKE_NOTIFY_SETTING: ParentWakeNotifySetting =
  "changed";

/**
 * The global default, read once per call rather than cached, so a test or a
 * future per-thread override can change it between calls. There is no
 * per-thread setting wired up yet; this is the single extensibility point a
 * future route would call through.
 */
export function resolveParentWakeNotifySetting(): ParentWakeNotifySetting {
  const raw = process.env.BB_PARENT_WAKE_NOTIFY;
  if (raw === undefined) {
    return DEFAULT_PARENT_WAKE_NOTIFY_SETTING;
  }
  const parsed = parentWakeNotifySettingSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_PARENT_WAKE_NOTIFY_SETTING;
}

/**
 * Whether a child turn was started by neither the parent thread nor a user —
 * a self-continuation (compaction, rotation) or a cascade from some other
 * thread's own notice (a grandchild waking the child, which then wakes the
 * parent). `getStoredTurnRequestEventForTurn` returns null for a turn no
 * client request drove at all, which is the purest form of self-initiated.
 */
export function isChildTurnSelfInitiated(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { childThreadId: string; parentThreadId: string; turnId: string },
): boolean {
  const requestRow = getStoredTurnRequestEventForTurn(deps.db, {
    threadId: args.childThreadId,
    turnId: args.turnId,
  });
  if (requestRow === null) {
    return true;
  }
  const data: unknown = JSON.parse(requestRow.data);
  const initiator =
    typeof data === "object" && data !== null && "initiator" in data
      ? (data as { initiator?: unknown }).initiator
      : undefined;
  const senderThreadId =
    typeof data === "object" && data !== null && "senderThreadId" in data
      ? (data as { senderThreadId?: unknown }).senderThreadId
      : undefined;
  if (initiator === "user") {
    return false;
  }
  if (senderThreadId === args.parentThreadId) {
    return false;
  }
  return true;
}

const lastDeliveredChildOutputByKey = new Map<string, string | null>();

function lastDeliveredKey(args: {
  childThreadId: string;
  parentThreadId: string;
}): string {
  return `${args.parentThreadId}:${args.childThreadId}`;
}

/**
 * The last final message actually delivered to this parent for this child,
 * in process memory. A restart forgets it, which only means the very next
 * notice after a restart cannot be deduped against one from before it — the
 * same trade-off the batching map beside this one already makes.
 */
export function recordDeliveredChildOutput(args: {
  childThreadId: string;
  parentThreadId: string;
  finalText: string | null;
}): void {
  lastDeliveredChildOutputByKey.set(lastDeliveredKey(args), args.finalText);
}

export function clearDeliveredChildOutputForTesting(): void {
  lastDeliveredChildOutputByKey.clear();
}

export interface DecideParentWakeArgs {
  childThreadId: string;
  finalText: string | null;
  notify: ParentWakeNotifySetting;
  parentThreadId: string;
  selfInitiated: boolean;
  turnStatus: ThreadEventTurnStatus;
}

export type ParentWakeSuppressReason =
  | "duplicate-final-message"
  | "self-initiated-unchanged";

export type DecideParentWakeResult =
  | { wake: true }
  | { wake: false; reason: ParentWakeSuppressReason };

/**
 * The policy function: whether a child turn's outcome should wake its
 * parent.
 *
 * `quiet` never wakes on its own. `all` always wakes. `changed` (the
 * default) suppresses two cases and wakes on everything else: a final
 * message identical to the last one already delivered for this child
 * (regardless of who started the turn), and a self-initiated turn — one
 * neither the parent nor a user started — that produced no final message at
 * all, i.e. a bare continuation with nothing new to report. A self-initiated
 * turn that does produce a new, non-duplicate message still wakes, and an
 * error or interruption always wakes regardless of duplication or origin.
 */
export function decideParentWake(
  args: DecideParentWakeArgs,
): DecideParentWakeResult {
  if (args.turnStatus !== "completed") {
    return { wake: true };
  }
  if (args.notify === "all") {
    return { wake: true };
  }
  if (args.notify === "quiet") {
    return { wake: false, reason: "self-initiated-unchanged" };
  }

  const previous = lastDeliveredChildOutputByKey.get(lastDeliveredKey(args));
  const isDuplicate = previous !== undefined && previous === args.finalText;
  if (isDuplicate) {
    return { wake: false, reason: "duplicate-final-message" };
  }
  if (args.selfInitiated && args.finalText === null) {
    return { wake: false, reason: "self-initiated-unchanged" };
  }
  return { wake: true };
}

export type ParentThreadHeldResult =
  | { held: false }
  | { held: true; pluginId: string; reason: string; sendAt: number | null };

/**
 * Whether a plugin's `message.dispatch` hook is holding this parent thread —
 * the same gate an ordinary send goes through, run here because the
 * parent-system-notice path otherwise bypasses it entirely (it never sends
 * through `attemptDispatch`).
 */
export async function checkParentThreadHeld(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { input: PromptInput[]; parentThread: Thread },
): Promise<ParentThreadHeldResult> {
  if (!hasMessageDispatchHooks()) {
    return { held: false };
  }
  const { parentThread } = args;
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: parentThread.id },
  );
  const attempt: DispatchAttemptKind =
    parentThread.status !== "active" ? "start-turn" : "join-turn";
  const outcome = await runMessageDispatchHookPass(deps, {
    thread: parentThread,
    threadResponse: toThreadResponseFromThread(deps, { thread: parentThread }),
    project: requirePublicProject(deps.db, parentThread.projectId),
    environmentId: parentThread.environmentId,
    intendedHostId:
      parentThread.environmentId !== null
        ? null
        : intendedThreadHostId(deps, parentThread.id),
    environmentIntent: intendedThreadEnvironmentIntent(deps, parentThread),
    input: args.input,
    requestedExecution: {
      providerId: parentThread.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
      permissionMode: execution.permissionMode,
    },
    executionSources: dispatchExecutionSources({}),
    attempt,
    initiator: "system",
    senderThreadId: null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: parentThread.parentThreadId,
    queuedMessages: [],
    pluginSubmission: null,
  });
  if (outcome.kind === "proceed") {
    return { held: false };
  }
  const waiter: MessageDispatchWaitDecision = outcome.waiter;
  return {
    held: true,
    pluginId: waiter.pluginId,
    reason: dispatchWaitReasonForPass(outcome),
    sendAt: waiter.sendAt,
  };
}
