import {
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getThread,
  requireThreadLifecycleEventApplied,
  type ClaimedQueuedThreadMessageRow,
  type DbTransaction,
} from "@bb/db";
import type {
  PromptInput,
  PromptMentionResource,
  PromptTextMention,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import { createQueuedThreadMessage } from "@bb/db";
import { emitPluginMessageQueued } from "../plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
  type PreparedTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  ensureThreadCanStartRequest,
  prepareReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import {
  appendClientTurnEventInTransaction,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  createClientTurnRequestId,
  getActiveTurnId,
} from "./thread-events.js";
import {
  dispatchTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { createQueuedMessageClaimLostError } from "./queue-waits.js";
import { queueInputForStartingTurn } from "./thread-turn-starting.js";
import {
  ThreadContextClearInProgressError,
  withThreadSendGuard,
} from "./thread-context-mutation-guard.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  checkParentThreadHeld,
  type ParentThreadHeldResult,
} from "./parent-wake-policy.js";

const PARENT_SYSTEM_MESSAGE_SOURCE = "tell";

export interface ParentSystemMessageTaxonomy {
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
}

interface QueueParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  input: PromptInput[];
  parentThreadId: string;
}

export interface ParentSystemRenderedMention {
  resource: PromptMentionResource;
  serializedText: string;
}

export interface ParentSystemThreadMentionSource {
  id: string;
  projectId: string;
  title: string | null;
}

interface ParentSystemTextSegment {
  kind: "text";
  text: string;
}

interface ParentSystemMentionSegment {
  kind: "mention";
  mention: ParentSystemRenderedMention;
}

export type ParentSystemInputSegment =
  | ParentSystemTextSegment
  | ParentSystemMentionSegment;

interface BuildParentSystemInputFromSegmentsArgs {
  segments: readonly ParentSystemInputSegment[];
}

interface BuildParentSystemInputFromTemplateSlotArgs {
  renderedText: string;
  segments: readonly ParentSystemInputSegment[];
  slot: string;
}

interface BuildParentSystemThreadMentionArgs {
  thread: ParentSystemThreadMentionSource;
}

interface RenderedParentSystemSlotParts {
  prefix: string;
  suffix: string;
}

/**
 * The claimed queue row(s) a delivery is spending, when the notice being
 * delivered is itself a queued row (a drain re-delivering it).
 *
 * The claim is validated and consumed INSIDE the same transaction that appends
 * the turn request, so a row deleted while a `message.dispatch` hook was
 * deciding cannot produce a turn: the consume finds it gone, throws claim-lost,
 * and the append rolls back. `state` records what became of the claim, because
 * one path (a turn that is still starting) keeps the row and re-queues it
 * instead of consuming it, and the caller must not then delete it.
 */
export interface ParentSystemClaim {
  rows: readonly ClaimedQueuedThreadMessageRow[];
  state: "held" | "consumed" | "requeued";
}

function consumeParentSystemClaimInTransaction(
  tx: DbTransaction,
  claim: ParentSystemClaim | undefined,
): void {
  if (claim === undefined) {
    return;
  }
  const consumed = deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
    queuedMessages: claim.rows,
  });
  if (!consumed) {
    throw createQueuedMessageClaimLostError();
  }
  claim.state = "consumed";
}

interface QueueReadyParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  claim?: ParentSystemClaim;
  environment: ReadyThreadEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  thread: Thread;
}

interface QueueActiveParentSystemMessageInTransactionArgs extends QueueReadyParentSystemMessageArgs {
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

function parentSystemTurnRequestFields(
  args: QueueReadyParentSystemMessageArgs,
) {
  return {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
    requestMethod: "turn/start",
    source: PARENT_SYSTEM_MESSAGE_SOURCE,
  } as const;
}

function splitRenderedParentSystemSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): RenderedParentSystemSlotParts {
  const start = args.renderedText.indexOf(args.slot);
  if (start === -1) {
    throw new Error("Parent system template slot was not found in message");
  }
  const next = args.renderedText.indexOf(args.slot, start + args.slot.length);
  if (next !== -1) {
    throw new Error("Parent system template slot must be unique in message");
  }

  return {
    prefix: args.renderedText.slice(0, start),
    suffix: args.renderedText.slice(start + args.slot.length),
  };
}

function buildParentSystemInputFromSegments(
  args: BuildParentSystemInputFromSegmentsArgs,
): PromptInput[] {
  let text = "";
  const mentions: PromptTextMention[] = [];

  for (const segment of args.segments) {
    if (segment.kind === "text") {
      text += segment.text;
      continue;
    }

    if (segment.mention.serializedText.length === 0) {
      throw new Error("Parent system mention text must not be empty");
    }
    const start = text.length;
    text += segment.mention.serializedText;
    mentions.push({
      start,
      end: text.length,
      resource: segment.mention.resource,
    });
  }

  return [{ type: "text", text, mentions }];
}

export function buildParentSystemInputFromTemplateSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): PromptInput[] {
  const parts = splitRenderedParentSystemSlot(args);
  return buildParentSystemInputFromSegments({
    segments: [
      { kind: "text", text: parts.prefix },
      ...args.segments,
      { kind: "text", text: parts.suffix },
    ],
  });
}

export function parentSystemThreadLabel(thread: {
  id: string;
  title: string | null;
}): string {
  return thread.title?.trim() || thread.id;
}

export function buildParentSystemThreadMention(
  args: BuildParentSystemThreadMentionArgs,
): ParentSystemRenderedMention {
  return {
    serializedText: `@thread:${args.thread.id}`,
    resource: {
      kind: "thread",
      label: parentSystemThreadLabel(args.thread),
      projectId: args.thread.projectId,
      threadId: args.thread.id,
    },
  };
}

function queueActiveParentSystemMessageInTransaction(
  tx: DbTransaction,
  args: QueueActiveParentSystemMessageInTransactionArgs,
): Extract<HostDaemonCommand, { type: "turn.submit" }> | null {
  const currentThread = getThread(tx, args.thread.id);
  if (
    !currentThread ||
    currentThread.environmentId !== args.environment.id ||
    currentThread.status !== "active" ||
    currentThread.archivedAt !== null ||
    currentThread.deletedAt !== null
  ) {
    return null;
  }

  const expectedSteerTurnId = getActiveTurnId({ db: tx }, args.thread.id);
  consumeParentSystemClaimInTransaction(tx, args.claim);
  const request = appendClientTurnEventInTransaction(tx, {
    ...parentSystemTurnRequestFields(args),
    target: {
      kind: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
  });
  return addRequestIdToTurnSubmitCommandPayload({
    requestId: request.requestId,
    preparedCommand: {
      ...args.preparedCommand,
      target: {
        mode: "auto",
        expectedTurnId: expectedSteerTurnId,
      },
    },
  });
}

async function queueActiveParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<boolean> {
  const expectedSteerTurnId = getActiveTurnId(deps, args.thread.id);
  if (expectedSteerTurnId === null) {
    const outcome = queueInputForStartingTurn(deps, {
      claimed: args.claim?.rows ?? null,
      input: {
        input: args.input,
        execution: args.execution,
        payload: { kind: "inline" },
        senderThreadId: null,
        origin: null,
        originPluginId: null,
        requestedBy: null,
        systemNotice: {
          kind: args.systemMessageKind,
          subject: args.systemMessageSubject,
        },
      },
      threadId: args.thread.id,
    });
    if (outcome.kind === "queued") {
      if (args.claim !== undefined) {
        // The claimed row itself now carries the wait; nothing was consumed.
        args.claim.state = "requeued";
      }
      return true;
    }
    if (outcome.kind === "dispatched") return false;
    if (outcome.kind === "retry") {
      const currentThread = outcome.thread;
      if (
        currentThread === null ||
        currentThread.archivedAt !== null ||
        currentThread.deletedAt !== null ||
        currentThread.status === "stopping"
      ) {
        return false;
      }
      return queueReadyParentSystemMessage(deps, {
        ...args,
        thread: currentThread,
      });
    }
  }
  const permissionEscalation = resolvePermissionEscalation({
    initiator: "system",
  });
  await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    thread: args.thread,
    input: args.input,
    execution: args.execution,
    permissionEscalation,
    target: {
      mode: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
    },
  });

  const command = deps.db.transaction(
    (tx) =>
      queueActiveParentSystemMessageInTransaction(tx, {
        ...args,
        preparedCommand,
      }),
    { behavior: "immediate" },
  );
  if (command === null) {
    return false;
  }

  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live active parent system message command failed",
      );
    },
  });
  return true;
}

async function queueReadyParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<boolean> {
  if (args.thread.status === "active") {
    return queueActiveParentSystemMessage(deps, args);
  }

  const permissionEscalation = resolvePermissionEscalation({
    initiator: "system",
  });
  const requestId = createClientTurnRequestId();

  const command = await prepareReadyThreadTurnCommand(deps, {
    thread: args.thread,
    fork: null,
    input: args.input,
    requestId,
    execution: args.execution,
    permissionEscalation,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
    },
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: false,
  });
  const activeThread: Thread | null = deps.db.transaction(
    (tx) => {
      ensureThreadCanStartRequest(args.thread);
      consumeParentSystemClaimInTransaction(tx, args.claim);
      appendPreparedClientTurnRequestedEventWithNotificationInTransaction(tx, {
        ...parentSystemTurnRequestFields(args),
        target: { kind: "new-turn" },
        requestId,
      });
      const dispatchKind = command.mode;
      if (dispatchKind !== "turn.submit") {
        return null;
      }
      return requireThreadLifecycleEventApplied(
        applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { event: { type: "run.started" }, threadId: args.thread.id },
        ),
      );
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command: command.command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live parent system message command failed",
      );
    },
  });
  if (activeThread) {
    deps.hub.notifyThread(
      args.thread.id,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, activeThread),
    );
  }
  return true;
}

/**
 * `checkParentThreadHeld` runs a plugin's `message.dispatch` hook, which is
 * fail-closed: a handler that throws, times out, or rejects raises rather
 * than returning a decision. Letting that propagate out of
 * `queueParentSystemMessage` would drop the notice entirely, since none of
 * its callers retry — they log and move on. Treat a failed hook check the
 * same as a held thread instead, so the notice is always recorded durably
 * and can be delivered once the thread is next dispatched to.
 */
async function checkParentThreadHeldTolerantly(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    continueAfterHooks?: () => Promise<void>;
    input: PromptInput[];
    parentThread: Thread;
  },
): Promise<ParentThreadHeldResult> {
  try {
    return await checkParentThreadHeld(deps, args);
  } catch (error) {
    deps.logger.error(
      { err: error, parentThreadId: args.parentThread.id },
      "Parent-thread dispatch-hook check failed; queuing the notice instead of dropping it",
    );
    return {
      held: true,
      pluginId: "unknown",
      reason:
        "A dispatch hook failed while checking whether this thread could be sent to.",
      sendAt: null,
    };
  }
}

export async function queueParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageArgs,
): Promise<boolean> {
  const parentThread = getThread(deps.db, args.parentThreadId);
  if (
    !parentThread ||
    parentThread.archivedAt !== null ||
    parentThread.deletedAt !== null
  ) {
    return false;
  }
  const hasPendingInteraction =
    deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(
      parentThread.id,
    );
  // Delivery is the hook pass's `continueAfterHooks`, so it commits before the
  // evaluation lock releases (a concurrency-limiting hook's next pass must see
  // this turn as running). Its outcome is captured rather than thrown: the
  // tolerant check below treats a throw as a failed hook, which a delivery
  // failure is not.
  const delivery: {
    result: { delivered: boolean } | { error: unknown } | null;
  } = { result: null };
  const deliverNow = async (): Promise<void> => {
    try {
      delivery.result = {
        delivered: await deliverParentSystemMessage(deps, {
          input: args.input,
          parentThread,
          systemMessageKind: args.systemMessageKind,
          systemMessageSubject: args.systemMessageSubject,
        }),
      };
    } catch (error) {
      delivery.result = { error };
    }
  };
  const held = hasPendingInteraction
    ? ({ held: false } as const)
    : await checkParentThreadHeldTolerantly(deps, {
        continueAfterHooks: deliverNow,
        input: args.input,
        parentThread,
      });
  if (!hasPendingInteraction && !held.held) {
    if (delivery.result === null) {
      await deliverNow();
    }
    const outcome = delivery.result!;
    if ("delivered" in outcome) {
      return outcome.delivered;
    }
    if (!(outcome.error instanceof ThreadContextClearInProgressError)) {
      throw outcome.error;
    }
  }

  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: parentThread.id,
    },
  );
  const queuedRow = createQueuedThreadMessage(deps.db, deps.hub, {
    threadId: parentThread.id,
    content: args.input,
    senderThreadId: null,
    origin: null,
    originPluginId: null,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    serviceTier: execution.serviceTier,
    waitingOn: hasPendingInteraction
      ? { kind: "interaction" }
      : held.held
        ? { kind: "plugin", pluginId: held.pluginId, reason: held.reason }
        : { kind: "thread-busy" },
    sendAt: held.held ? held.sendAt : null,
    payload: { kind: "inline" },
    systemNotice: {
      kind: args.systemMessageKind,
      subject: args.systemMessageSubject,
    },
  });
  // The DB helper only announces queue-changed. A plugin waiter learns of a
  // new row through `message.queued` (as for every row recordQueuedMessageWait
  // writes), so without this a held notice stalls until an unrelated recheck.
  emitPluginMessageQueued(toThreadQueuedMessage(queuedRow));
  if (!hasPendingInteraction && !held.held) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: parentThread.id,
    });
  }
  return true;
}

interface DeliverParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  /** Set when delivering a claimed queue row; see {@link ParentSystemClaim}. */
  claim?: ParentSystemClaim;
  input: PromptInput[];
  parentThread: Thread;
}

/**
 * Dispatches a parent-system notice, with no interaction check of its own.
 *
 * Split out so the queue drain can deliver a notice that QUEUED on an
 * interaction without re-entering the check that queued it — which, on a
 * thread whose interaction settled a moment ago, would otherwise be a race
 * that could queue a second copy of the same notice.
 */
export async function deliverParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DeliverParentSystemMessageArgs,
): Promise<boolean> {
  return withThreadSendGuard(args.parentThread.id, () =>
    deliverParentSystemMessageWithContextGuard(deps, args),
  );
}

async function deliverParentSystemMessageWithContextGuard(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DeliverParentSystemMessageArgs,
): Promise<boolean> {
  const { parentThread } = args;
  const { environment } = requireThreadEnvironment(deps.db, parentThread.id);
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: parentThread.id,
    },
  );
  if (
    await dispatchTurnDuringReprovision({
      beforeRequestAppendInTransaction: ({ tx }) =>
        consumeParentSystemClaimInTransaction(tx, args.claim),
      deps,
      environment,
      execution,
      initiator: "system",
      input: args.input,
      senderThreadId: null,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      thread: parentThread,
    })
  ) {
    return true;
  }

  const readyEnvironment = requireReadyThreadEnvironment(
    getEnvironment(deps.db, environment.id) ?? environment,
  );
  return await queueReadyParentSystemMessage(deps, {
    ...(args.claim !== undefined ? { claim: args.claim } : {}),
    thread: parentThread,
    input: args.input,
    execution,
    environment: readyEnvironment,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
  });
}
