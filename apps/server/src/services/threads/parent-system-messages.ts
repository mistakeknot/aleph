import { systemMessageWakeCause } from "./system-message-kind.js";
import { producerWakeRef } from "./producer-wake-ref.js";
import {
  createQueuedThreadMessageInTransaction,
  getThread,
  QueuedMessageThreadUnavailableError,
} from "@bb/db";
import type {
  PromptInput,
  PromptMentionResource,
  PromptTextMention,
  SystemMessageKind,
  Thread,
  SystemMessageSubject,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { attemptQueuedMessageNow } from "./queued-message-dispatch.js";
import { emitPluginMessageQueued } from "../plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import {
  INGRESS_ADMISSION_ATTEMPTS,
  RetirementAppearedError,
  assertAdmittedDestinationInTransaction,
  resolveRetiredIngress,
} from "./retired-ingress.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { ApiError } from "../../errors.js";

export interface ParentSystemMessageTaxonomy {
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
}

interface QueueParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  wakeRef?: string;
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

function isHostRefusal(error: ApiError): boolean {
  return (
    error.body.code === "machine_removing" ||
    error.body.code === "host_not_found"
  );
}

export async function queueParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageArgs,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await queueParentSystemMessageToResolvedParent(deps, args);
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

async function queueParentSystemMessageToResolvedParent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageArgs,
): Promise<boolean> {
  const requestedParent = getThread(deps.db, args.parentThreadId);
  if (requestedParent === null || requestedParent.deletedAt !== null) {
    return false;
  }
  const resolution = resolveRetiredIngress(deps.db, requestedParent, {
    refuseUserPosts: false,
  });
  if (resolution.kind === "unavailable") {
    return false;
  }
  const parentThread = resolution.thread;
  if (!isWritableParent(parentThread)) {
    return false;
  }
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: parentThread.id },
  );
  let row: ReturnType<typeof createQueuedThreadMessageInTransaction> | null;
  try {
    row = deps.db.transaction(
      (tx) => {
        if (!isWritableParent(getThread(tx, parentThread.id))) return null;
        assertAdmittedDestinationInTransaction(
          tx,
          requestedParent.id,
          parentThread.id,
        );
        assertThreadHostAcceptsWork(tx, parentThread);
        return createQueuedThreadMessageInTransaction(tx, {
          threadId: requestedParent.id,
          wakeCause: systemMessageWakeCause(args.systemMessageKind),
          wakeRef: producerWakeRef(args.wakeRef ?? crypto.randomUUID()),
          content: args.input,
          senderThreadId: null,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: {
            kind: args.systemMessageKind,
            subject: args.systemMessageSubject,
          },
          deliveryMode: "steer",
        });
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof ApiError && isHostRefusal(error)) {
      deps.logger.warn(
        { parentThreadId: parentThread.id, code: error.body.code },
        "Parent system notice dropped: the parent thread's machine is not accepting work",
      );
      return false;
    }
    if (!(error instanceof QueuedMessageThreadUnavailableError)) throw error;
    deps.logger.warn(
      {
        parentThreadId: parentThread.id,
        reason: error.reason,
        phase: "post-hook",
        dropped: true,
      },
      "Parent system notice dropped: the parent thread is no longer writable",
    );
    return false;
  }
  if (row === null) return false;
  emitPluginMessageQueued(toThreadQueuedMessage(row));
  deps.hub.notifyThread(row.threadId, ["queue-changed"]);
  if (row.threadId !== requestedParent.id) {
    deps.hub.notifyThread(requestedParent.id, ["queue-changed"]);
  }
  await attemptQueuedMessageNow(deps, row);
  return true;
}

function isWritableParent(thread: Thread | null): thread is Thread {
  return (
    thread !== null && thread.archivedAt === null && thread.deletedAt === null
  );
}
