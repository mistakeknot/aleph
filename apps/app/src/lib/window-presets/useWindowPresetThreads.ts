import { useQuery } from "@tanstack/react-query";
import type { ThreadListResponse } from "@bb/server-contract";
import { threadListQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import type { PresetThreadCandidate } from "./resolve";

const PRESET_THREAD_LIMIT = 500;

function toPresetThreadCandidates(
  threads: ThreadListResponse,
): PresetThreadCandidate[] {
  return threads.map((thread) => ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    pinnedAt: thread.pinnedAt,
    updatedAt: thread.updatedAt,
  }));
}

export function useWindowPresetThreads(enabled: boolean) {
  return useQuery<ThreadListResponse, Error, PresetThreadCandidate[]>({
    queryKey: threadListQueryKey({
      archived: false,
      limit: PRESET_THREAD_LIMIT,
    }),
    queryFn: ({ signal }) =>
      sdk.threads.list({
        archived: false,
        limit: PRESET_THREAD_LIMIT,
        signal,
      }),
    select: toPresetThreadCandidates,
    enabled,
    staleTime: 15_000,
  });
}
