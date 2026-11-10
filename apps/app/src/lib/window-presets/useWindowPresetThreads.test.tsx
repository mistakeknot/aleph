// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { getCachedThreadListPlaceholder } from "@/hooks/cache-owners/query-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowPresetThreads } from "./useWindowPresetThreads";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { list: vi.fn() } },
}));

describe("useWindowPresetThreads", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("returns preset candidates and keeps full thread entries in the shared thread list cache", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();
    const entry = makeThreadListEntry({
      id: "thread-1",
      projectId: "project-1",
      title: "Coordinator",
    });
    vi.mocked(sdk.threads.list).mockResolvedValueOnce([entry]);

    const { result } = renderHook(() => useWindowPresetThreads(true), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toEqual([
      {
        id: entry.id,
        projectId: entry.projectId,
        title: entry.title,
        titleFallback: entry.titleFallback,
        pinnedAt: entry.pinnedAt,
        updatedAt: entry.updatedAt,
      },
    ]);
    expect(getCachedThreadListPlaceholder(queryClient, entry.id)).toEqual(
      entry,
    );
  });
});
