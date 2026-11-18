import { useCallback, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { BbHttpError } from "@bb/sdk/browser";
import type { SystemAlephUpdateStatus } from "@bb/server-contract";
import {
  postAlephInstallCancel,
  postAlephInstallRequest,
} from "@/lib/aleph-update-api";
import { generateAlephNonce } from "@/lib/aleph-update-nonce";
import { invalidateAlephUpdateStatus } from "./cache-owners/app-update-cache-owner";

export interface AlephInstallRequestState {
  error: string | null;
  pending: boolean;
  cancel(nonce: string): void;
  request(target: NonNullable<SystemAlephUpdateStatus["target"]>): void;
}

function messageFrom(error: unknown): string {
  if (error instanceof BbHttpError) return error.message;
  return error instanceof Error ? error.message : "Request failed";
}

async function runAlephInstallRequest(
  send: () => Promise<unknown>,
  busy: { current: boolean },
  setPending: (pending: boolean) => void,
  setError: (error: string | null) => void,
  queryClient: QueryClient,
) {
  if (busy.current) return;
  busy.current = true;
  setPending(true);
  setError(null);
  try {
    await send();
  } catch (failure) {
    setError(messageFrom(failure));
  } finally {
    busy.current = false;
    setPending(false);
    invalidateAlephUpdateStatus({ queryClient });
  }
}

export function useAlephInstallRequest(): AlephInstallRequestState {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    async (send: () => Promise<unknown>) => {
      await runAlephInstallRequest(
        send,
        busy,
        setPending,
        setError,
        queryClient,
      );
    },
    [queryClient],
  );

  const request = useCallback(
    (target: NonNullable<SystemAlephUpdateStatus["target"]>) => {
      void run(() =>
        postAlephInstallRequest({
          manifestDigest: target.manifestDigest,
          nonce: generateAlephNonce(),
          target: target.version,
        }),
      );
    },
    [run],
  );

  const cancel = useCallback(
    (nonce: string) => {
      void run(() => postAlephInstallCancel({ nonce }));
    },
    [run],
  );

  return { cancel, error, pending, request };
}
