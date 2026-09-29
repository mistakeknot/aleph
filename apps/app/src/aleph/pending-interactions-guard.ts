import { useEffect, useRef } from "react";
import { emitDiagnostic, toDiagnosticId } from "@/lib/diagnostics";

export const PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS = 5_000;
export const PENDING_INTERACTIONS_AUTO_RETRY_INTERVAL_MS = 5_000;

export class PendingInteractionsRequestTimeoutError extends Error {
  constructor() {
    super("Pending interactions request timed out");
    this.name = "PendingInteractionsRequestTimeoutError";
  }
}

export function pendingInteractionsRefetchInterval(query: {
  state: { status: string };
}): number | false {
  return query.state.status === "error"
    ? PENDING_INTERACTIONS_AUTO_RETRY_INTERVAL_MS
    : false;
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

type GateState = "verified" | "checking" | "failed";

interface PendingInteractionsGateQuery {
  status: "error" | "pending" | "success";
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

interface UsePendingInteractionsGateArgs {
  hasPendingInteraction: boolean;
  query: PendingInteractionsGateQuery;
  threadId: string;
}

export interface PendingInteractionsGate {
  isUnverified: boolean;
  retry: (() => void) | null;
}

interface LastGateState {
  state: GateState;
  threadId: string;
}

export function usePendingInteractionsGate({
  hasPendingInteraction,
  query,
  threadId,
}: UsePendingInteractionsGateArgs): PendingInteractionsGate {
  const state: GateState = hasPendingInteraction
    ? "verified"
    : query.status === "error"
      ? "failed"
      : query.status === "success" && !query.isFetching
        ? "verified"
        : "checking";
  const last = useRef<LastGateState | null>(null);
  useEffect(() => {
    const previous = last.current?.threadId === threadId ? last.current : null;
    last.current = { state, threadId };
    const previousState = previous?.state ?? "verified";
    if (previousState === state) {
      return;
    }
    const outcome =
      state === "verified"
        ? "resolved"
        : state === "failed"
          ? "check-failed"
          : "blocked-unverified";
    emitDiagnostic(() => ({
      kind: "pending-interactions-guard",
      outcome,
      threadId: toDiagnosticId(threadId),
    }));
  }, [state, threadId]);
  const refetch = query.refetch;
  const retry =
    state === "failed"
      ? () => {
          emitDiagnostic(() => ({
            kind: "pending-interactions-guard",
            outcome: "manual-retry",
            threadId: toDiagnosticId(threadId),
          }));
          void refetch();
        }
      : null;
  return { isUnverified: state !== "verified", retry };
}
