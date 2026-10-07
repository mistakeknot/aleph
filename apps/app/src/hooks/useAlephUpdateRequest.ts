import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BbHttpError } from "@bb/sdk/browser";
import type { SystemAlephUpdateRun } from "@bb/server-contract";
import { alephErrorCommand, postAlephUpdate } from "@/lib/aleph-update-api";
import {
  ALEPH_MANUAL_ERROR_CODES,
  ALEPH_NONCE_UNKNOWN_MS,
  alephClockWentBackward,
  alephElapsedMs,
  alephOutcomeUnknownMessage,
  createAlephNonceStore,
  isAlephAmbiguousStatus,
  evaluateAlephPending,
  type AlephPendingRequest,
  type AlephUpdateOperation,
} from "@/lib/aleph-update-nonce";
import { invalidateAlephUpdateStatus } from "./cache-owners/app-update-cache-owner";
import { useAlephUpdateRun } from "./queries/aleph-update-queries";

export interface AlephRequestFailure {
  command: string | null;
  message: string;
}

export interface AlephRequestState {
  failure: AlephRequestFailure | null;
  finished: SystemAlephUpdateRun | null;
  pending: AlephPendingRequest | null;
  runState: SystemAlephUpdateRun["state"] | null;
  unknownMessage: string | null;
  dismiss(): void;
  submit(operation: AlephUpdateOperation, body: Record<string, unknown>): void;
}

function failureFrom(error: unknown): AlephRequestFailure {
  if (error instanceof BbHttpError) {
    return { command: alephErrorCommand(error), message: error.message };
  }
  return {
    command: null,
    message: error instanceof Error ? error.message : "Request failed",
  };
}

const UNKNOWN_TICK_MS = 1_000;

export function useAlephUpdateRequest(): AlephRequestState {
  const queryClient = useQueryClient();
  const store = useMemo(
    () =>
      createAlephNonceStore(
        typeof window === "undefined"
          ? { getItem: () => null, removeItem: () => {}, setItem: () => {} }
          : window.localStorage,
      ),
    [],
  );
  const [pending, setPending] = useState<AlephPendingRequest | null>(() =>
    store.read(),
  );
  const [failure, setFailure] = useState<AlephRequestFailure | null>(() => {
    const stored = store.read();
    return stored?.manualCommand === undefined
      ? null
      : {
          command: stored.manualCommand,
          message: "Run the command from a root shell to start the update",
        };
  });
  const [finished, setFinished] = useState<SystemAlephUpdateRun | null>(null);
  const [unknownMessage, setUnknownMessage] = useState<string | null>(null);
  const run = useAlephUpdateRun(pending?.nonce ?? null);
  const [dismissedNonce, setDismissedNonce] = useState<string | null>(null);
  const sending = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const elapsed = useRef<{ nonce: string; ms: number } | null>(null);

  const elapsedNow = useCallback((request: AlephPendingRequest) => {
    const wall = alephElapsedMs(request, Date.now());
    const tracked = elapsed.current;
    return tracked?.nonce === request.nonce ? Math.max(tracked.ms, wall) : wall;
  }, []);

  const send = useCallback(
    async (request: AlephPendingRequest) => {
      if (sending.current) return;
      sending.current = true;
      try {
        await postAlephUpdate(request.operation, {
          ...request.body,
          nonce: request.nonce,
        });
      } catch (error) {
        if (!(error instanceof BbHttpError)) return;
        const failed = failureFrom(error);
        if (
          error.code !== null &&
          ALEPH_MANUAL_ERROR_CODES.has(error.code) &&
          failed.command !== null
        ) {
          const manual = store.markManual(failed.command);
          if (manual !== null) setPending(manual);
          setFailure(failed);
        } else if (!isAlephAmbiguousStatus(error.status)) {
          store.resolve();
          setPending(null);
          setFailure(failed);
        }
      } finally {
        sending.current = false;
      }
    },
    [store],
  );

  const submit = useCallback(
    (operation: AlephUpdateOperation, body: Record<string, unknown>) => {
      if (pendingRef.current !== null) return;
      setFailure(null);
      setFinished(null);
      setUnknownMessage(null);
      const request = store.begin(operation, body);
      setPending(request);
      void send(request);
    },
    [send, store],
  );

  const dismiss = useCallback(() => {
    setDismissedNonce(pendingRef.current?.nonce ?? null);
    setFinished(null);
    setUnknownMessage(null);
    setFailure(null);
  }, []);

  useEffect(() => {
    if (pending === null || run.data === undefined) return;
    const action = evaluateAlephPending(
      pending,
      run.data.state,
      Date.now(),
      elapsedNow(pending),
    );
    if (action === "resolved") {
      store.resolve();
      setPending(null);
      setUnknownMessage(null);
      setFinished(run.data);
      invalidateAlephUpdateStatus({ queryClient });
    } else if (action === "resend") {
      store.markResent();
      const resent = { ...pending, resent: true };
      setPending(resent);
      void send(resent);
    } else if (action === "outcome-unknown") {
      setUnknownMessage(alephOutcomeUnknownMessage(pending.nonce));
    }
  }, [
    elapsedNow,
    pending,
    queryClient,
    run.data,
    run.dataUpdatedAt,
    send,
    store,
  ]);

  const pendingNonce = pending?.nonce ?? null;
  useEffect(() => {
    if (pendingNonce === null) return;
    const stored = store.read();
    if (stored === null || stored.nonce !== pendingNonce) return;
    let ms = alephClockWentBackward(stored, Date.now())
      ? ALEPH_NONCE_UNKNOWN_MS
      : elapsedNow(stored);
    let last = performance.now();
    elapsed.current = { nonce: pendingNonce, ms };
    const check = () => {
      const mono = performance.now();
      ms = Math.max(
        ms + Math.max(mono - last, UNKNOWN_TICK_MS),
        elapsedNow(stored),
      );
      last = mono;
      elapsed.current = { nonce: pendingNonce, ms };
      store.recordElapsed(ms, Date.now());
      if (ms < ALEPH_NONCE_UNKNOWN_MS) return false;
      setUnknownMessage(alephOutcomeUnknownMessage(pendingNonce));
      return true;
    };
    if (ms >= ALEPH_NONCE_UNKNOWN_MS) {
      setUnknownMessage(alephOutcomeUnknownMessage(pendingNonce));
      return;
    }
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, UNKNOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [elapsedNow, pendingNonce, store]);

  return {
    dismiss,
    failure,
    finished,
    pending,
    runState: run.data?.state ?? null,
    submit,
    unknownMessage:
      dismissedNonce !== null && dismissedNonce === pending?.nonce
        ? null
        : unknownMessage,
  };
}
