import type { ThreadListEntry } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import { threadQueryOptions } from "../queries/thread-queries";
import { updateCachedThreadListPendingInteractionState } from "./query-cache";
import { beginUnarchiveThreadTransaction } from "./thread-state-cache-owner";

const THREAD_ID = "thr_deep";

function sidebarThreads(queryClient: {
  getQueryData: <T>(key: readonly unknown[]) => T | undefined;
}): ThreadListEntry[] {
  const data = queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );
  return [
    ...(data?.personalProject.threads ?? []),
    ...(data?.projects.flatMap((project) => project.threads) ?? []),
  ];
}

describe("thread entity partial list facet", () => {
  it("does not put a row without activity into the sidebar when unarchiving a detail-only thread", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ id: "project-1" })],
      }),
    );
    queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({
        id: THREAD_ID,
        projectId: "project-1",
        archivedAt: 5,
      }),
    );
    updateCachedThreadListPendingInteractionState(queryClient, THREAD_ID, true);

    await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: THREAD_ID,
    });

    for (const row of sidebarThreads(queryClient))
      expect(row.activity).toBeDefined();
  });

  it("builds a thread placeholder from whatever the sidebar holds without throwing", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ id: "project-1" })],
      }),
    );
    queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({
        id: THREAD_ID,
        projectId: "project-1",
        archivedAt: 5,
      }),
    );
    updateCachedThreadListPendingInteractionState(queryClient, THREAD_ID, true);
    await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: THREAD_ID,
    });
    queryClient.removeQueries({ queryKey: threadQueryKey(THREAD_ID) });

    const placeholder = threadQueryOptions(
      queryClient,
      THREAD_ID,
    ).placeholderData;
    expect(() =>
      typeof placeholder === "function"
        ? placeholder(undefined, undefined)
        : placeholder,
    ).not.toThrow();
  });
});
