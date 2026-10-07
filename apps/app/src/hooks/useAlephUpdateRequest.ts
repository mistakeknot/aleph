import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BbHttpError } from "@bb/sdk/browser";
import type { SystemAlephUpdateRun } from "@bb/server-contract";
import { alephErrorCommand, postAlephUpdate } from "@/lib/aleph-update-api";
import {
  alephOutcomeUnknownMessage,
  createAlephNonceStore,
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
  const [failure, setFailure] = useState<AlephRequestFailure | null>(null);
  const [finished, setFinished] = useState<SystemAlephUpdateRun | null>(null);
  const [unknownMessage, setUnknownMessage] = useState<string | null>(null);
  const run = useAlephUpdateRun(pending?.nonce ?? null);
  const sending = useRef(false);

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
        if (error instanceof BbHttpError) {
          store.resolve();
          setPending(null);
          setFailure(failureFrom(error));
        }
      } finally {
        sending.current = false;
      }
    },
    [store],
  );

  const submit = useCallback(
    (operation: AlephUpdateOperation, body: Record<string, unknown>) => {
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
    store.resolve();
    setPending(null);
    setFinished(null);
    setUnknownMessage(null);
    setFailure(null);
  }, [store]);

  useEffect(() => {
    if (pending === null || run.data === undefined) return;
    const action = evaluateAlephPending(pending, run.data.state, Date.now());
    if (action === "resolved") {
      store.resolve();
      setPending(null);
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
  }, [pending, queryClient, run.data, run.dataUpdatedAt, send, store]);

  return {
    dismiss,
    failure,
    finished,
    pending,
    runState: run.data?.state ?? null,
    submit,
    unknownMessage,
  };
}
