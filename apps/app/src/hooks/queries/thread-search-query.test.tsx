// @vitest-environment jsdom

import type { ThreadSearchResponse } from "@bb/server-contract";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadSearch } from "./thread-queries";

const threadsSdk = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: threadsSdk },
}));

interface SearchCall {
  query: string;
  signal: AbortSignal | undefined;
  resolve: (response: ThreadSearchResponse) => void;
}

function emptyResponse(total: number): ThreadSearchResponse {
  return {
    active: { total, results: [] },
    archived: { total: 0, results: [] },
  };
}

function trackSearchCalls(): SearchCall[] {
  const calls: SearchCall[] = [];
  threadsSdk.search.mockImplementation(
    (input: { query: string; signal?: AbortSignal }) =>
      new Promise<ThreadSearchResponse>((resolve) => {
        calls.push({ query: input.query, signal: input.signal, resolve });
      }),
  );
  return calls;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderSearch(initialQuery: string) {
  const { wrapper } = createQueryClientTestHarness();
  return renderHook(({ active, query }) => useThreadSearch({ active, query }), {
    initialProps: { active: true, query: initialQuery },
    wrapper,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useThreadSearch", () => {
  it.each([
    ["an empty query", ""],
    ["a one-character query", "a"],
    ["a whitespace-only query", "   "],
    ["a query with one non-whitespace character", " a "],
  ])("does not search for %s", async (_label, query) => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query });
    await advance(500);

    expect(calls).toHaveLength(0);
    expect(result.current.hasSearchableQuery).toBe(false);
    expect(result.current.isDebouncing).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("searches the first searchable input immediately and debounces follow-ups by 60ms", async () => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    expect(calls.map((call) => call.query)).toEqual(["ab"]);
    expect(result.current.isDebouncing).toBe(false);

    rerender({ active: true, query: "abc" });
    expect(result.current.isDebouncing).toBe(true);
    await advance(59);
    expect(calls.map((call) => call.query)).toEqual(["ab"]);

    await advance(1);
    expect(calls.map((call) => call.query)).toEqual(["ab", "abc"]);
    expect(result.current.isDebouncing).toBe(false);
  });

  it("collapses rapid keystrokes into one search for the last value", async () => {
    const calls = trackSearchCalls();
    const { rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    rerender({ active: true, query: "abc" });
    await advance(30);
    rerender({ active: true, query: "abcd" });
    await advance(30);
    rerender({ active: true, query: "abcde" });
    await advance(60);

    expect(calls.map((call) => call.query)).toEqual(["ab", "abcde"]);
  });

  it("searches immediately again after the query is cleared", async () => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    rerender({ active: true, query: "" });
    await advance(0);
    expect(result.current.isDebouncing).toBe(false);
    expect(calls).toHaveLength(1);

    await advance(60);
    expect(result.current.hasSearchableQuery).toBe(false);
    expect(result.current.debouncedQuery).toBe("");

    rerender({ active: true, query: "xy" });
    await advance(0);
    expect(calls.map((call) => call.query)).toEqual(["ab", "xy"]);
  });

  it("drops a pending follow-up when the query is cleared before the debounce fires", async () => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    rerender({ active: true, query: "abc" });
    await advance(30);
    rerender({ active: true, query: "" });
    await advance(200);

    expect(calls.map((call) => call.query)).toEqual(["ab"]);
    expect(result.current.isDebouncing).toBe(false);
    expect(result.current.hasSearchableQuery).toBe(false);
  });

  it("does not search while inactive and searches once activated", async () => {
    const calls = trackSearchCalls();
    const { rerender } = renderSearch("ab");

    await advance(200);
    rerender({ active: false, query: "ab" });
    await advance(200);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(emptyResponse(1));
    await advance(0);

    rerender({ active: false, query: "abc" });
    await advance(200);
    expect(calls).toHaveLength(1);

    rerender({ active: true, query: "abc" });
    await advance(0);
    expect(calls.map((call) => call.query)).toEqual(["ab", "abc"]);
  });

  it("aborts the superseded request when the debounced query changes", async () => {
    const calls = trackSearchCalls();
    const { rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    const first = calls[0];
    expect(first?.signal?.aborted).toBe(false);

    rerender({ active: true, query: "abc" });
    await advance(60);

    expect(calls.map((call) => call.query)).toEqual(["ab", "abc"]);
    expect(first?.signal?.aborted).toBe(true);
  });

  it("ignores a late response for a superseded query", async () => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    rerender({ active: true, query: "abc" });
    await advance(60);
    expect(calls).toHaveLength(2);

    calls[1]?.resolve(emptyResponse(2));
    await advance(0);
    expect(result.current.data?.active.total).toBe(2);

    calls[0]?.resolve(emptyResponse(1));
    await advance(0);
    expect(result.current.debouncedQuery).toBe("abc");
    expect(result.current.data?.active.total).toBe(2);
  });

  it("serves a repeated query from the cache without another request", async () => {
    const calls = trackSearchCalls();
    const { result, rerender } = renderSearch("");

    rerender({ active: true, query: "ab" });
    await advance(0);
    calls[0]?.resolve(emptyResponse(1));
    await advance(0);
    expect(result.current.data?.active.total).toBe(1);

    rerender({ active: true, query: "abc" });
    await advance(60);
    calls[1]?.resolve(emptyResponse(2));
    await advance(0);

    rerender({ active: true, query: "ab" });
    await advance(60);

    expect(calls.map((call) => call.query)).toEqual(["ab", "abc"]);
    expect(result.current.data?.active.total).toBe(1);
  });
});
