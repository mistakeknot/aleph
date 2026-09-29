import type { ChangedMessage } from "@bb/server-contract";
import { shouldQueueFollowUpMessage } from "@bb/client-core";
import type { DiagnosticPayload } from "@/lib/diagnostics";
import { toDiagnosticId } from "@/lib/diagnostics";

export const THREAD_SEQUENCE_LONG_GAP_MS = 5 * 60 * 1000;

type ThreadSequencePayload = Extract<
  DiagnosticPayload,
  { kind: "thread-sequence-anomaly" }
>;

interface LastStatusChange {
  busy: boolean;
  updatedAt: number;
}

export class ThreadSequenceTracker {
  private readonly lastByThreadId = new Map<string, LastStatusChange>();

  observe(message: ChangedMessage): ThreadSequencePayload | null {
    if (message.entity !== "thread" || message.id === undefined) {
      return null;
    }
    const statusChange = message.metadata?.statusChange;
    const threadId = toDiagnosticId(message.id);
    if (statusChange === undefined || threadId === null) {
      return null;
    }
    const previous = this.lastByThreadId.get(threadId);
    const busy = shouldQueueFollowUpMessage(statusChange.runtime.displayStatus);
    if (
      previous === undefined ||
      statusChange.updatedAt >= previous.updatedAt
    ) {
      this.lastByThreadId.set(threadId, {
        busy,
        updatedAt: statusChange.updatedAt,
      });
    }
    if (previous === undefined) {
      return null;
    }
    const deltaMs = statusChange.updatedAt - previous.updatedAt;
    if (deltaMs < 0) {
      return {
        kind: "thread-sequence-anomaly",
        anomaly: "out-of-order",
        deltaMs,
        previousUpdatedAt: previous.updatedAt,
        statusUpdatedAt: statusChange.updatedAt,
        threadId,
      };
    }
    if (previous.busy && deltaMs > THREAD_SEQUENCE_LONG_GAP_MS) {
      return {
        kind: "thread-sequence-anomaly",
        anomaly: "long-gap",
        deltaMs,
        previousUpdatedAt: previous.updatedAt,
        statusUpdatedAt: statusChange.updatedAt,
        threadId,
      };
    }
    return null;
  }
}
