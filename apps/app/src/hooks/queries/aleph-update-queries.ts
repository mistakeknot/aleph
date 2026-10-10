import { useQuery } from "@tanstack/react-query";
import type {
  SystemAlephUpdateRun,
  SystemAlephUpdateStatus,
} from "@bb/server-contract";
import { BbHttpError } from "@bb/sdk/browser";
import {
  fetchAlephUpdateRun,
  fetchAlephUpdateStatus,
} from "@/lib/aleph-update-api";
import { systemAlephUpdateQueryKey } from "./query-keys";
import type { QueryOptions } from "./query-helpers";
import { FOCUS_OWNED_LIVE_QUERY_POLICY } from "./query-policies";

const ALEPH_RUN_POLL_INTERVAL_MS = 2_000;

export function useAlephUpdateStatus(options?: QueryOptions) {
  return useQuery<SystemAlephUpdateStatus>({
    queryKey: systemAlephUpdateQueryKey(),
    queryFn: ({ signal }) => fetchAlephUpdateStatus(signal),
    enabled: options?.enabled ?? true,
    retry: (count, error) =>
      !(error instanceof BbHttpError && error.status === 404) && count < 2,
    ...FOCUS_OWNED_LIVE_QUERY_POLICY,
  });
}

export function useAlephUpdateRun(nonce: string | null) {
  return useQuery<SystemAlephUpdateRun>({
    queryKey: [...systemAlephUpdateQueryKey(), "run", nonce],
    queryFn: ({ signal }) => fetchAlephUpdateRun(nonce ?? "", signal),
    enabled: nonce !== null,
    refetchInterval: ALEPH_RUN_POLL_INTERVAL_MS,
    retry: false,
    staleTime: 0,
  });
}
