import { useEffect, useState } from "react";
import { emitDiagnostic, toDiagnosticId } from "@/lib/diagnostics";

export const PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS = 10_000;
export const PENDING_INTERACTIONS_UNKNOWN_GRACE_MS = 1_000;

export class PendingInteractionsRequestTimeoutError extends Error {
  constructor() {
    super("Pending interactions request timed out");
    this.name = "PendingInteractionsRequestTimeoutError";
  }
}

interface WithRequestTimeoutArgs<T> {
  request: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  threadId: string;
  timeoutMs?: number;
}

export function withPendingInteractionsRequestTimeout<T>({
  request,
  signal,
  threadId,
  timeoutMs = PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS,
}: WithRequestTimeoutArgs<T>): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitDiagnostic(() => ({
        kind: "pending-interactions-guard",
        outcome: "request-timeout",
        threadId: toDiagnosticId(threadId),
      }));
      const error = new PendingInteractionsRequestTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    };
    request(controller.signal).then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

interface UseGracedPendingInteractionFetchingArgs {
  hasPendingInteraction: boolean;
  isFetching: boolean;
  threadId: string;
}

export function useGracedPendingInteractionFetching({
  hasPendingInteraction,
  isFetching,
  threadId,
}: UseGracedPendingInteractionFetchingArgs): boolean {
  const [graceExpired, setGraceExpired] = useState(false);
  const waiting = isFetching && !hasPendingInteraction;
  useEffect(() => {
    if (!waiting) {
      setGraceExpired(false);
      return;
    }
    const timer = setTimeout(() => {
      setGraceExpired(true);
      emitDiagnostic(() => ({
        kind: "pending-interactions-guard",
        outcome: "grace-expired",
        threadId: toDiagnosticId(threadId),
      }));
    }, PENDING_INTERACTIONS_UNKNOWN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [threadId, waiting]);
  return isFetching && !(waiting && graceExpired);
}
