import { useQuery } from "@tanstack/react-query";
import { threadListQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import type { PresetThreadCandidate } from "./resolve";

const PRESET_THREAD_LIMIT = 500;

export function useWindowPresetThreads(enabled: boolean) {
  return useQuery<PresetThreadCandidate[]>({
    queryKey: threadListQueryKey({
      archived: false,
      limit: PRESET_THREAD_LIMIT,
    }),
    queryFn: async ({ signal }) => {
      const threads = await sdk.threads.list({
        archived: false,
        limit: PRESET_THREAD_LIMIT,
        signal,
      });
      return threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        titleFallback: thread.titleFallback,
        pinnedAt: thread.pinnedAt,
        updatedAt: thread.updatedAt,
      }));
    },
    enabled,
    staleTime: 15_000,
  });
}
