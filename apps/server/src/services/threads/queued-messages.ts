import { listStoredClientTurnRequestRowsByKeys } from "@bb/db";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import { readWake, wakeAttribution } from "@bb/domain";
import { retiredUserPostsMode } from "./retired-user-posts.js";
import {
  abortTransferOperation,
  isThreadEventsCold,
  isAppUpdateSendHoldSet,
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessageInTransaction,
  listUnemittedTransferEvents,
  markTransferEventEmitted,
  getEnvironment,
  getHost,
  getTransferOperation,
  getQueuedThreadMessage,
  getStoredProviderSession,
  getThread,
  holdQueuedThreadMessageForEdit,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  getRedirectSuccessorThreadId,
  ONLINE_QUEUE_MOVE_MAX_ROWS,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  sweepTransferOperations,
  retireQueuedThreadMessages,
  SourceQueueTooLargeError,
  TransferTargetRetiredError,
  transferAllQueuedThreadMessagesInTransaction,
  transferQueuedThreadMessageInTransaction,
  QueuedMessageThreadUnavailableError,
  type DbQueryConnection,
  type AbortResult,
  type RetireResult,
  type QueuedThreadMessageExecution,
  type QueuedThreadMessageGroupClaimPolicy,
  type QueuedThreadMessageGroupEligibility,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  isQueuedMessageFailedState,
} from "@bb/domain";
import type {
  QueuedMessageDeliveryMode,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  QueuedMessageEditHoldResponse,
  SendMessageRequest,
  SendQueuedMessageMode,
  TransferAllQueuedMessagesResponse,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import {
  parseStoredQueuedThreadMessageSystemNotice,
  parseStoredQueuedThreadMessageWaitingOn,
  storedQueuedThreadMessageRequestedBy,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getActiveTurnId,
  isActiveTurnMainRunIdle,
  isManualCompactionActive,
} from "./thread-events.js";
import { attemptDispatch, threadTargetHostId } from "./dispatch-attempt.js";
import {
  createQueuedMessageClaimLostError,
  QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
  QUEUED_MESSAGE_CLAIM_LOST_CODE,
} from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  deliverPluginMessageQueuedTransfer,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import {
  captureUserMessageSentTelemetry,
  ensureThreadQueueIsWritable,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import {
  INGRESS_ADMISSION_ATTEMPTS,
  RetirementAppearedError,
  assertAdmittedDestinationInTransaction,
  resolveRetiredIngress,
} from "./retired-ingress.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
  throwThreadNotWritable,
} from "../lib/lifecycle-api-errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { pinThreadHistory } from "./event-cold-tier/pins.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { ThreadContextClearInProgressError } from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs {
  claimPolicy: QueuedThreadMessageGroupClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessageGroup>,
  null
>[number];

interface SendClaimedQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  /** True for an explicit "send now"; false for an ordinary drain. */
  sendNow: boolean;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  thread: Thread;
}

export function createAutomaticQueuedMessageGroupEligibility(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { now: number; retryingFailure: boolean; thread: Thread },
): QueuedThreadMessageGroupEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  return (group) =>
    group.every((member) => {
      if (isQueuedMessageFailedState(member.state) && !args.retryingFailure)
        return false;
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(member);
      switch (waitingOn?.kind) {
        case undefined:
        case "plugin":
          return true;
        case "time":
          return member.sendAt !== null && member.sendAt <= args.now;
        case "thread-busy":
          return (
            args.thread.status === "idle" ||
            args.thread.status === "pending" ||
            isActiveTurnMainRunIdle(deps, args.thread)
          );
        case "stopping":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
        case "turn-starting":
          return (
            args.thread.status === "idle" ||
            (args.thread.status === "active" && activeTurnId !== null)
          );
        case "host-offline": {
          const environment =
            args.thread.environmentId === null
              ? null
              : getEnvironment(deps.db, args.thread.environmentId);
          const host =
            environment === null ? null : getHost(deps.db, environment.hostId);
          return (
            host !== null &&
            host.destroyedAt === null &&
            host.phase === "active" &&
            deps.hub.hasDaemonForHost(host.id)
          );
        }
        case "app-update":
          return !isAppUpdateSendHoldSet(deps.db);
        case "provisioning":
        case "interaction":
        case "superseded":
          return false;
      }
    });
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { hasProviderSession: boolean } {
  ensureThreadQueueIsWritable(thread);
  const hasProviderSession =
    getStoredProviderSession(db, thread.id).kind !== "none";
  if (thread.environmentId === null) {
    if (hasProviderSession) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { hasProviderSession };
  }
  const environment = getEnvironment(db, thread.environmentId);
  assertThreadHostAcceptsWork(db, thread);
  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }
  return { hasProviderSession };
}

function emitQueuedIfHeld(entry: ThreadQueuedMessage): void {
  if (entry.waitingOn?.kind === "plugin" || entry.waitingOn?.kind === "time") {
    emitPluginMessageQueued(entry);
  }
}

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await createQueuedMessageForResolvedThread(deps, args);
    } catch (error) {
      if (
        !(error instanceof RetirementAppearedError) ||
        attempt + 1 >= INGRESS_ADMISSION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

async function createQueuedMessageForResolvedThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const { payload } = args;
  const resolution = resolveRetiredIngress(deps.db, args.thread, {
    refuseUserPosts: true,
  });
  if (resolution.kind === "unavailable") {
    throwThreadNotWritable(args.thread, resolution.reason, "Thread is retired");
  }
  const thread = resolution.thread;
  ensureThreadQueueIsWritable(thread);
  const input = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
    hostId: threadTargetHostId(deps, thread),
  });
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  const { currentThread, hasProviderSession, queuedMessage } = mapUnavailable(
    deps,
    thread,
    () =>
      deps.db.transaction(
        (tx) => {
          const currentThread = getThread(tx, thread.id);
          if (!currentThread) {
            throw new ApiError(404, "thread_not_found", "Thread not found");
          }
          assertAdmittedDestinationInTransaction(tx, args.thread.id, thread.id);
          const { hasProviderSession } = admitQueuedMessage(tx, currentThread);
          const queuedMessage = createQueuedThreadMessageInTransaction(tx, {
            threadId: args.thread.id,
            content: input,
            ...wakeAttribution(payload),
            senderThreadId,
            retiredPosts: retiredUserPostsMode(),
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            permissionMode: execution.permissionMode,
            serviceTier: execution.serviceTier,
            // An explicit "queue this" is a message waiting for the running turn
            // to end, which is exactly `thread-busy`. Naming it rather than
            // leaving the wait null keeps every row on one vocabulary, and the
            // idle drain treats the two identically anyway.
            //
            // Queued while the thread is stopping, or after a manual stop whose
            // pause is still in force, it is instead a message the user
            // composed AFTER asking for the stop, so it carries `stopping` and
            // runs once the thread is idle rather than joining the rows the
            // manual-stop pause holds back.
            waitingOn:
              currentThread.status === "stopping" ||
              isThreadQueueAutoSendPaused(tx, currentThread.id)
                ? { kind: "stopping" }
                : { kind: "thread-busy" },
            sendAt: null,
            payload: { kind: "inline" },
            systemNotice: null,
            deliveryMode: "queue",
          });
          return { currentThread, hasProviderSession, queuedMessage };
        },
        { behavior: "immediate" },
      ),
  );
  const landedThreadId = queuedMessage.threadId;
  deps.hub.notifyThread(landedThreadId, ["queue-changed"]);
  if (senderThreadId === null && payload.input.length > 0) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: thread.parentThreadId !== null,
      messageSource: "queued_message",
      providerId: thread.providerId,
      initiator: "user",
    });
  }
  if (
    landedThreadId !== args.thread.id ||
    (currentThread.status === "idle" && hasProviderSession) ||
    isActiveTurnMainRunIdle(deps, currentThread)
  ) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: landedThreadId,
    });
  }
  return toThreadQueuedMessage(queuedMessage);
}

function mapUnavailable<T>(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof QueuedMessageThreadUnavailableError) {
      throwThreadNotWritable(
        getThread(deps.db, thread.id) ?? thread,
        error.reason,
        "Thread is retired",
      );
    }
    throw error;
  }
}

function mapTargetRetired<T>(targetThread: Thread, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof TransferTargetRetiredError) {
      throwThreadNotWritable(
        targetThread,
        "target_retired",
        "Target thread has been retired",
      );
    }
    throw error;
  }
}

function mapTransferAllRefusal<T>(
  args: TransferAllQueuedMessagesArgs,
  run: () => T,
): T {
  try {
    return mapTargetRetired(args.targetThread, run);
  } catch (error) {
    if (error instanceof SourceQueueTooLargeError) {
      throwThreadNotWritable(
        args.sourceThread,
        "source_queue_too_large",
        error.message,
      );
    }
    throw error;
  }
}

export interface RetireThreadArgs {
  sourceThreadId: string;
  targetThreadId: string;
  operationKey: string;
}

export async function retireThread(
  deps: AppDeps,
  args: RetireThreadArgs,
): Promise<RetireResult> {
  const source = getThread(deps.db, args.sourceThreadId);
  const target = getThread(deps.db, args.targetThreadId);
  const project = source ?? target;
  if (!project) {
    throwThreadNotWritable(
      { archivedAt: null, deletedAt: null, status: "idle" },
      "unknown_thread",
      "Thread not found",
    );
  }
  const outcome = retireQueuedThreadMessages(deps.db, {
    projectId: project.projectId,
    sourceThreadId: args.sourceThreadId,
    targetThreadId: args.targetThreadId,
    operationKey: args.operationKey,
    retireEnabled: process.env.ALEPH_TRANSFER_RETIRE !== "off",
    admitTarget: (tx) => {
      const currentTarget = getThread(tx, args.targetThreadId);
      if (currentTarget) admitQueuedMessage(tx, currentTarget);
    },
    resolveWaitingOn: (row) => {
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(row);
      if (waitingOn?.kind === "plugin" || waitingOn?.kind === "time") {
        return waitingOn;
      }
      return target?.status === "stopping"
        ? { kind: "stopping" }
        : { kind: "thread-busy" };
    },
  });
  if (outcome.kind === "idempotency_conflict") {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Operation key was already used for a different request",
    );
  }
  if (outcome.kind === "refused") {
    throwThreadNotWritable(
      target ?? project,
      outcome.reason,
      "Thread cannot be retired",
    );
  }
  if (outcome.kind === "replayed") {
    await drainTransferLedger(deps);
    return outcome.result;
  }
  await drainTransferLedger(deps);
  if (target?.status === "idle") {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: args.targetThreadId,
    });
  }
  return outcome.result;
}

export interface AbortRetirementArgs {
  operationId: string;
  operationKey: string;
  expectedRetirementOperationId: string;
}

export async function abortRetirement(
  deps: AppDeps,
  args: AbortRetirementArgs,
): Promise<AbortResult> {
  const operation = getTransferOperation(deps.db, args.operationId);
  if (!operation) {
    throw new ApiError(404, "not_found", "Transfer operation not found");
  }
  const source = getThread(deps.db, operation.sourceThreadId);
  const outcome = abortTransferOperation(deps.db, {
    projectId: operation.projectId,
    operationId: args.operationId,
    expectedRetirementOperationId: args.expectedRetirementOperationId,
    operationKey: args.operationKey,
    maxReturnedRows: ONLINE_QUEUE_MOVE_MAX_ROWS,
    resolveWaitingOn: (row) => {
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(row);
      if (waitingOn?.kind === "plugin" || waitingOn?.kind === "time") {
        return waitingOn;
      }
      return source?.status === "stopping"
        ? { kind: "stopping" }
        : { kind: "thread-busy" };
    },
  });
  if (outcome.kind === "idempotency_conflict") {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Operation key was already used for a different request",
    );
  }
  if (outcome.kind === "refused") {
    throwThreadNotWritable(
      source ?? { archivedAt: null, deletedAt: null, status: "idle" },
      outcome.reason,
      outcome.reason === "abort_queue_too_large"
        ? `Retirement cannot be aborted online: it would return more than the ${ONLINE_QUEUE_MOVE_MAX_ROWS} queued messages that can move at once`
        : "Retirement cannot be aborted",
    );
  }
  await drainTransferLedger(deps);
  if (source?.status === "idle") {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: source.id,
    });
  }
  return outcome.result;
}

function carriesLandedRow(payload: { kind: string; state: string }): boolean {
  if (payload.kind === "moved" || payload.kind === "returned") return true;
  return payload.kind === "slot" && payload.state === "forwarded";
}

export async function drainTransferLedger(
  deps: Pick<AppDeps, "db" | "hub">,
): Promise<void> {
  let progressed: boolean;
  do {
    progressed = false;
    const notified = new Set<string>();
    for (const event of listUnemittedTransferEvents(deps.db)) {
      let entry: ThreadQueuedMessage | null = null;
      if (event.payload.rowId && carriesLandedRow(event.payload)) {
        const row = getQueuedThreadMessage(deps.db, event.payload.rowId);
        entry = row ? toThreadQueuedMessage(row) : null;
      }
      const delivered = await deliverPluginMessageQueuedTransfer(entry, {
        eventId: event.eventId,
        operationId: event.opId,
        entryId: event.entryId,
        kind: event.payload.kind,
        state: event.payload.state,
        rowId: event.payload.rowId,
        sourceRowId: event.payload.sourceId,
        originId: event.payload.origin,
      });
      if (!delivered) continue;
      markTransferEventEmitted(deps.db, event.eventId);
      progressed = true;
      if (notified.has(event.opId)) continue;
      notified.add(event.opId);
      const operation = getTransferOperation(deps.db, event.opId);
      if (!operation) continue;
      deps.hub.notifyThread(operation.sourceThreadId, ["queue-changed"]);
      deps.hub.notifyThread(operation.targetThreadId, ["queue-changed"]);
    }
  } while (progressed);
  sweepTransferOperations(deps.db);
}

export interface TransferQueuedMessageArgs {
  queuedMessageId: string;
  sourceThread: Thread;
  targetThread: Thread;
}

export async function transferQueuedMessage(
  deps: AppDeps,
  args: TransferQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const { queuedMessageId, sourceThread, targetThread } = args;
  if (sourceThread.id === targetThread.id) {
    throw new ApiError(
      400,
      "invalid_request",
      "Queued message is already on that thread",
    );
  }
  if (sourceThread.projectId !== targetThread.projectId) {
    throw new ApiError(
      400,
      "invalid_request",
      "Queued messages can only be transferred within a project",
    );
  }
  ensureThreadQueueIsWritable(targetThread);
  const result = mapTargetRetired(targetThread, () =>
    deps.db.transaction(
      (tx) => {
        const currentTarget = getThread(tx, targetThread.id);
        if (!currentTarget) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        admitQueuedMessage(tx, currentTarget);
        const transferred = transferQueuedThreadMessageInTransaction(tx, {
          queuedMessageId,
          sourceThreadId: sourceThread.id,
          targetThreadId: targetThread.id,
          resolveWaitingOn: (source) => {
            const waitingOn = parseStoredQueuedThreadMessageWaitingOn(source);
            if (waitingOn?.kind === "plugin" || waitingOn?.kind === "time") {
              return waitingOn;
            }
            return currentTarget.status === "stopping"
              ? { kind: "stopping" }
              : { kind: "thread-busy" };
          },
        });
        return { currentTarget, transferred };
      },
      { behavior: "immediate" },
    ),
  );
  const { currentTarget, transferred } = result;
  if (transferred.kind === "not_found") {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  if (transferred.kind === "claimed") {
    throw new ApiError(
      409,
      "invalid_request",
      "Queued message is already being sent",
    );
  }
  if (transferred.kind === "not_inline") {
    throw new ApiError(
      400,
      "invalid_request",
      "Only inline queued messages can be transferred",
    );
  }
  deps.hub.notifyThread(sourceThread.id, ["queue-changed"]);
  deps.hub.notifyThread(targetThread.id, ["queue-changed"]);
  const movedEntry = toThreadQueuedMessage(transferred.queuedMessage);
  emitQueuedIfHeld(movedEntry);
  if (currentTarget.status === "idle") {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: targetThread.id,
    });
  }
  return movedEntry;
}

export interface TransferAllQueuedMessagesArgs {
  sourceThread: Thread;
  targetThread: Thread;
}

export async function transferAllQueuedMessages(
  deps: AppDeps,
  args: TransferAllQueuedMessagesArgs,
): Promise<TransferAllQueuedMessagesResponse> {
  const { sourceThread, targetThread } = args;
  if (sourceThread.id === targetThread.id) {
    throw new ApiError(
      400,
      "invalid_request",
      "Queued messages are already on that thread",
    );
  }
  if (sourceThread.projectId !== targetThread.projectId) {
    throw new ApiError(
      400,
      "invalid_request",
      "Queued messages can only be transferred within a project",
    );
  }
  ensureThreadQueueIsWritable(targetThread);
  const { currentTarget, transferred } = mapTransferAllRefusal(args, () =>
    deps.db.transaction(
      (tx) => {
        const currentTarget = getThread(tx, targetThread.id);
        if (!currentTarget) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        admitQueuedMessage(tx, currentTarget);
        const transferred = transferAllQueuedThreadMessagesInTransaction(tx, {
          sourceThreadId: sourceThread.id,
          targetThreadId: targetThread.id,
          resolveWaitingOn: (source) => {
            const waitingOn = parseStoredQueuedThreadMessageWaitingOn(source);
            if (waitingOn?.kind === "plugin" || waitingOn?.kind === "time") {
              return waitingOn;
            }
            return currentTarget.status === "stopping"
              ? { kind: "stopping" }
              : { kind: "thread-busy" };
          },
        });
        return { currentTarget, transferred };
      },
      { behavior: "immediate" },
    ),
  );
  if (transferred.moved.length > 0) {
    deps.hub.notifyThread(sourceThread.id, ["queue-changed"]);
    deps.hub.notifyThread(targetThread.id, ["queue-changed"]);
    for (const row of transferred.moved) {
      emitQueuedIfHeld(toThreadQueuedMessage(row.queuedMessage));
    }
    if (currentTarget.status === "idle") {
      requestQueuedMessageDispatch(deps, {
        kind: "thread-ready",
        threadId: targetThread.id,
      });
    }
  }
  return {
    moved: transferred.moved.map((row) => ({
      id: row.id,
      newId: row.queuedMessage.id,
    })),
    skipped: transferred.skipped,
  };
}

export interface ResolveQueuedMessageExecutionChangeArgs {
  expectedUpdatedAt: number;
  queuedMessageId: string;
  request: Pick<
    UpdateQueuedMessageRequest,
    "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
  >;
  thread: Thread;
}

export async function resolveQueuedMessageExecutionChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: ResolveQueuedMessageExecutionChangeArgs,
): Promise<QueuedThreadMessageExecution | null> {
  const { request } = args;
  if (
    request.model === undefined &&
    request.permissionMode === undefined &&
    request.reasoningLevel === undefined &&
    request.serviceTier === undefined
  ) {
    return null;
  }
  const row = getQueuedThreadMessage(deps.db, args.queuedMessageId);
  if (
    row === null ||
    row.threadId !== args.thread.id ||
    row.state === "claimed" ||
    row.updatedAt !== args.expectedUpdatedAt
  ) {
    return null;
  }
  const current = toThreadQueuedMessage(row);
  const resolved = await buildExecutionOptions(
    deps,
    {
      model: request.model ?? current.model,
      permissionMode: request.permissionMode ?? current.permissionMode,
      reasoningLevel: request.reasoningLevel ?? current.reasoningLevel,
      serviceTier: request.serviceTier ?? current.serviceTier,
    },
    { threadId: args.thread.id },
  );
  return {
    model: resolved.model,
    permissionMode: resolved.permissionMode,
    reasoningLevel: resolved.reasoningLevel,
    serviceTier: resolved.serviceTier,
  };
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS = 2 * 60 * 1000;
const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    args.queuedMessages.some(isOrdinaryTurnEndQueuedMessage)
  );
}

function sendModeForDeliveryMode(
  group: readonly { deliveryMode: QueuedMessageDeliveryMode }[],
): SendMessageRequest["mode"] {
  return group.some((row) => row.deliveryMode === "queue")
    ? "queue-if-active"
    : "auto";
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendMessageRequest["mode"],
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

async function releaseQueuedMessageClaims(
  deps: LoggedPendingInteractionWorkSessionDeps,
  queuedMessages: readonly ClaimedQueuedMessage[],
): Promise<void> {
  const threadIds = new Set<string>();
  for (const queuedMessage of queuedMessages) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
    threadIds.add(queuedMessage.threadId);
  }
  await drainTransferLedger(deps);
  for (const threadId of [...threadIds]) {
    const successorId = getRedirectSuccessorThreadId(deps.db, threadId);
    if (successorId !== null) {
      threadIds.add(successorId);
    }
  }
  for (const threadId of threadIds) {
    if (getThread(deps.db, threadId)?.status === "idle") {
      requestQueuedMessageDispatch(deps, { kind: "thread-ready", threadId });
    }
  }
}

async function withActiveQueuedMessageClaims<T>(
  queuedMessages: readonly ClaimedQueuedMessage[],
  task: () => Promise<T>,
): Promise<T> {
  for (const queuedMessage of queuedMessages) {
    activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  }
  try {
    return await task();
  } finally {
    for (const queuedMessage of queuedMessages) {
      activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
    }
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedMessage[] {
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const claimedQueuedMessages = claimQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    args.claimPolicy,
  );
  if (claimedQueuedMessages) {
    return claimedQueuedMessages;
  }
  if (args.claimPolicy.kind === "automatic") return [];

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessages: args.queuedMessages,
    sendNow: args.sendNow,
    thread,
  });
}

/**
 * Re-attempts a claimed group through the dispatch checkpoint.
 *
 * The drain is nothing but a re-attempt: the same checkpoint runs, so a row
 * whose wait cleared but whose thread went busy in the meantime simply queues
 * again on the new reason rather than dispatching into a running turn. The
 * claim the caller already won is handed to the attempt, which either consumes
 * it inside the dispatch transaction (exactly once) or gives it back.
 */
async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const releasePin = pinThreadHistory(args.thread.id);
  try {
    const thread = getThread(deps.db, args.thread.id);
    if (
      !thread ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      isThreadEventsCold(deps.db, thread.id)
    ) {
      throw createQueuedMessageClaimLostError();
    }
    return await sendPinnedClaimedQueuedMessageForThread(deps, {
      ...args,
      thread,
    });
  } finally {
    releasePin();
  }
}

async function sendPinnedClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const queuedMessage = queuedMessages[0]!;
  const inputGroups = queuedMessages.map(
    (queuedMessage) => queuedMessage.content,
  );
  const input = flattenPromptInputGroups(inputGroups);
  const lead = args.queuedMessages[0]!;
  const mode =
    args.mode === "auto" && !args.sendNow
      ? sendModeForDeliveryMode(args.queuedMessages)
      : args.mode;
  const systemNotice = parseStoredQueuedThreadMessageSystemNotice(lead);
  const original =
    queuedMessage.payload.kind === "retry"
      ? listStoredClientTurnRequestRowsByKeys(deps.db, {
          keys: [
            {
              threadId: args.thread.id,
              requestId: queuedMessage.payload.retryOfTurnRequestId,
            },
          ],
        })[0]
      : undefined;
  const retained =
    original === undefined ? undefined : parseStoredTurnRequestEvent(original);
  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: {
      ...readWake(lead),
      wakeRef: lead.wakeRef ?? undefined,
      wakeCause:
        new Set(queuedMessages.map((entry) => entry.wakeCause)).size === 1
          ? queuedMessage.wakeCause
          : "unknown",
      wakeSources: queuedMessages.flatMap(
        (entry) => entry.wakeSources ?? [readWake(entry)],
      ),
      wakeSourcesTruncated: queuedMessages.some(
        (entry) => entry.wakeSourcesTruncated === true,
      ),
      ...(queuedMessage.payload.kind === "retry"
        ? {
            retainedCause:
              retained?.retainedCause ?? retained?.wakeCause ?? "unknown",
          }
        : {}),
      ...(systemNotice === null
        ? sendQueuedMessagePayload(
            { ...queuedMessage, content: input },
            mode,
            lead.senderThreadId,
          )
        : { input, mode }),
      ...(inputGroups.length > 1 ? { inputGroups } : {}),
    },
    source: {
      kind: "drain",
      claimed: args.queuedMessages,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    pluginSubmission: null,
    systemNotice,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    trigger: "auto-dispatch",
  });
  if (
    args.sendNow &&
    args.mode !== "steer" &&
    outcome.kind === "queued" &&
    outcome.entry.waitingOn?.kind !== "stopping"
  ) {
    // "Send now" overrides every plugin wait and the row's own schedule, but
    // not a core wait — those guard invariants rather than express a policy.
    // The row is back on the queue with its new reason; say so rather than
    // returning a success the caller would read as "it went".
    //
    // `stopping` is the one core wait Send-now does clear, because pressing it
    // is what clears it: the row leaves the manual-stop pause behind and
    // dispatches when the stop lands. Refusing would leave the user no way to
    // express that intent until the stop finished.
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }
  return queuedMessage;
}

/** The user-facing half of a core wait, for a refused "Send now". */
function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    case "app-update":
      return "bb is restarting to update";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "superseded":
      return "a newer message was sent after it";
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const entryThread = getThread(deps.db, args.threadId);
  if (entryThread && isThreadEventsCold(deps.db, entryThread.id)) {
    throwThreadNotWritable(entryThread, "archived", "Thread is archived");
  }
  const releasePin = pinThreadHistory(args.threadId);
  try {
    return await sendPinnedQueuedMessage(deps, args);
  } finally {
    releasePin();
  }
}

async function sendPinnedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessages = claimQueuedThreadMessageForSend(deps, args);
  if (queuedMessages.length === 0) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");
    return toThreadQueuedMessage(existing);
  }
  try {
    return await sendClaimedQueuedMessageGroup(deps, args, queuedMessages);
  } finally {
    if (getThread(deps.db, args.threadId)?.status === "idle") {
      requestQueuedMessageDispatch(deps, {
        kind: "thread-ready",
        threadId: args.threadId,
      });
    }
  }
}

async function sendClaimedQueuedMessageGroup(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
  queuedMessages: ClaimedQueuedMessage[],
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const thread = getThread(deps.db, args.threadId);
  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        queuedMessages.some(isOrdinaryTurnEndQueuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    await releaseQueuedMessageClaims(deps, queuedMessages);
    return toThreadQueuedMessage(queuedMessages[0]!);
  }
  try {
    return await withActiveQueuedMessageClaims(queuedMessages, () =>
      sendClaimedQueuedMessage(deps, {
        mode: args.mode,
        queuedMessages,
        sendNow,
        threadId: args.threadId,
      }),
    );
  } catch (error) {
    await releaseQueuedMessageClaims(deps, queuedMessages);
    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return toThreadQueuedMessage(queuedMessages[0]!);
    }
    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    mode: SendQueuedMessageMode;
    queuedMessageId: string;
    threadId: string;
  },
): Promise<
  | { delivery: "sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
> {
  await sendQueuedMessage(deps, {
    claimPolicy: { kind: "explicit-send" },
    mode: args.mode,
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);
  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessages = claimNextQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageGroupEligibility(deps, {
      now: Date.now(),
      retryingFailure: false,
      thread: initialThread,
    }),
  );
  if (!nextQueuedMessages) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);
  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    await releaseQueuedMessageClaims(deps, nextQueuedMessages);
    return false;
  }

  try {
    await withActiveQueuedMessageClaims(nextQueuedMessages, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessages: nextQueuedMessages,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    await releaseQueuedMessageClaims(deps, nextQueuedMessages);
    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return false;
    }
    // Nobody is listening to this attempt, so the row itself has to carry what
    // happened — either as a `host-offline` wait it can recover from, or as a
    // failure reason the queued row renders. A host timeout is excluded: the
    // command is still in flight, so the attempt has not failed yet.
    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        now: Date.now(),
        row: nextQueuedMessages[0]!,
        thread,
      });
    }
    throw error;
  }
  return true;
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

export function releaseOrphanedQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): number {
  return releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now + 1,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

interface QueuedMessageEditHoldArgs {
  queuedMessageId: string;
  threadId: string;
}

export function holdQueuedMessageForEdit(
  deps: Pick<AppDeps, "db">,
  args: QueuedMessageEditHoldArgs,
): QueuedMessageEditHoldResponse {
  const result = holdQueuedThreadMessageForEdit(deps.db, {
    heldUntil: Date.now() + QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS,
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
  switch (result.kind) {
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "held":
      return { leaseMs: QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS };
  }
}

export function requestEditReleasedQueuedMessageDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  requestQueuedMessageDispatch(deps, {
    kind: "edit-released",
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
}

export function releaseQueuedMessageEditHold(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  if (
    releaseQueuedThreadMessageEditHold(deps.db, {
      id: args.queuedMessageId,
      threadId: args.threadId,
    })
  ) {
    requestEditReleasedQueuedMessageDispatch(deps, args);
  }
}
