import {
  mergeWakeProvenance,
  wakeProvenanceSchema,
  type WakeAttribution,
} from "@bb/domain";
import { z } from "zod";
import {
  createQueuedThreadMessageInTransaction,
  deleteCoalescedQueuedThreadMessageInTransaction,
  getPendingCoalescedQueuedThreadMessage,
  resolveQueuedMessageDestination,
  updateCoalescedQueuedThreadMessageInTransaction,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type {
  PromptInput,
  QueuedMessageSystemNotice,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  emitPluginMessageCancelled,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

export interface CoalescedNotice<State> {
  input: PromptInput[];
  notice: QueuedMessageSystemNotice;
  state: State;
}

export interface PostCoalescedSystemNoticeArgs<State> extends WakeAttribution {
  coalesceKey: string;
  execution: ResolvedThreadExecutionOptions;
  merge: (previous: State | null) => CoalescedNotice<State> | null;
  parseState: (stored: string) => State;
  threadId: string;
  windowMs: number;
}

type CoalescedNoticeWrite =
  | { kind: "created"; row: QueuedThreadMessageRow }
  | { kind: "merged"; row: QueuedThreadMessageRow }
  | { kind: "withdrawn"; row: QueuedThreadMessageRow }
  | { kind: "none" };

export function postCoalescedSystemNotice<State>(
  deps: Pick<AppDeps, "db" | "hub">,
  args: PostCoalescedSystemNoticeArgs<State>,
): QueuedThreadMessageRow | null {
  const sendAt = Date.now() + args.windowMs;
  const write = deps.db.transaction(
    (tx): CoalescedNoticeWrite => {
      const destination = resolveQueuedMessageDestination(tx, {
        threadId: args.threadId,
      });
      const pending = getPendingCoalescedQueuedThreadMessage(tx, {
        coalesceKey: args.coalesceKey,
        threadId: destination.threadId,
      });
      const stored =
        pending?.coalesceState == null
          ? null
          : JSON.parse(pending.coalesceState);
      const envelope = z
        .object({ state: z.unknown(), wake: wakeProvenanceSchema })
        .safeParse(stored);
      const provenance = mergeWakeProvenance(
        envelope.success
          ? envelope.data.wake
          : pending === null
            ? null
            : {
                sources: [{ wakeCause: "unknown", wakeRef: null }],
                truncated: false,
              },
        args,
      );
      const next = args.merge(
        pending?.coalesceState == null
          ? null
          : args.parseState(
              envelope.success
                ? JSON.stringify(envelope.data.state)
                : pending.coalesceState,
            ),
      );
      if (next === null) {
        const withdrawn =
          pending === null
            ? null
            : deleteCoalescedQueuedThreadMessageInTransaction(tx, pending);
        return withdrawn === null
          ? { kind: "none" }
          : { kind: "withdrawn", row: withdrawn };
      }
      const merged =
        pending === null
          ? null
          : updateCoalescedQueuedThreadMessageInTransaction(tx, {
              coalesceState: JSON.stringify({
                state: next.state,
                wake: provenance,
              }),
              wakeCause: provenance.wakeCause,
              wakeRef: provenance.wakeRef,
              content: next.input,
              id: pending.id,
              systemNotice: next.notice,
              threadId: destination.threadId,
              windowEndsAt: sendAt,
            });
      if (merged !== null) return { kind: "merged", row: merged };
      return {
        kind: "created",
        row: createQueuedThreadMessageInTransaction(tx, {
          threadId: args.threadId,
          wakeCause: provenance.wakeCause,
          wakeRef: provenance.wakeRef,
          content: next.input,
          senderThreadId: null,
          model: args.execution.model,
          reasoningLevel: args.execution.reasoningLevel,
          permissionMode: args.execution.permissionMode,
          serviceTier: args.execution.serviceTier,
          waitingOn: { kind: "time" },
          sendAt,
          payload: { kind: "inline" },
          systemNotice: next.notice,
          deliveryMode: "steer",
          coalesce: {
            key: args.coalesceKey,
            state: JSON.stringify({ state: next.state, wake: provenance }),
          },
        }),
      };
    },
    { behavior: "immediate" },
  );
  if (write.kind === "none") return null;
  if (write.kind === "withdrawn") {
    emitPluginMessageCancelled(toThreadQueuedMessage(write.row));
  } else if (write.kind === "created") {
    emitPluginMessageQueued(toThreadQueuedMessage(write.row));
  }
  deps.hub.notifyThread(write.row.threadId, ["queue-changed"]);
  if (write.row.threadId !== args.threadId) {
    deps.hub.notifyThread(args.threadId, ["queue-changed"]);
  }
  return write.kind === "withdrawn" ? null : write.row;
}
