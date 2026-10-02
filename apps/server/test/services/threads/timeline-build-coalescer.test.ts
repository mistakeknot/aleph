import { describe, expect, it } from "vitest";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { createTimelineBuildCoalescer } from "../../../src/services/threads/timeline-build-coalescer.js";

interface Harness {
  advance(ms: number): void;
  builds: number[];
  coalescer: ReturnType<typeof createTimelineBuildCoalescer>;
  refreshes: string[];
  serve(
    maxSeq: number,
    overrides?: { coalesce?: boolean; paramsKey?: string; threadId?: string },
  ): { response: ThreadTimelineResponse; stale: boolean };
}

function responseAt(maxSeq: number): ThreadTimelineResponse {
  return { maxSeq, rows: [] } as unknown as ThreadTimelineResponse;
}

function createHarness(
  options: { buildMs?: number; maxBytes?: number; maxEntries?: number } = {},
): Harness {
  let clock = 0;
  const timers: { at: number; cancelled: boolean; run: () => void }[] = [];
  const builds: number[] = [];
  const refreshes: string[] = [];
  const coalescer = createTimelineBuildCoalescer({
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxEntries === undefined
      ? {}
      : { maxEntries: options.maxEntries }),
    now: () => clock,
    onTrailingRefresh: (threadId) => refreshes.push(threadId),
    schedule: (run, delayMs) => {
      const timer = { at: clock + delayMs, cancelled: false, run };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    advance(ms) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.run();
        }
      }
    },
    builds,
    coalescer,
    refreshes,
    serve(maxSeq, overrides = {}) {
      return coalescer.serve({
        build: () => {
          builds.push(maxSeq);
          clock += options.buildMs ?? 100;
          return responseAt(maxSeq);
        },
        coalesce: overrides.coalesce ?? true,
        maxSeq,
        paramsKey: overrides.paramsKey ?? "params",
        threadId: overrides.threadId ?? "thread-1",
      });
    },
  };
}

describe("timeline build coalescer", () => {
  it("serves the same snapshot for an unchanged maxSeq", () => {
    const harness = createHarness();
    const first = harness.serve(10);
    const second = harness.serve(10);
    expect(second.response).toBe(first.response);
    expect(second.stale).toBe(false);
    expect(harness.builds).toEqual([10]);
  });

  it("serves the last snapshot during a burst and builds once per window", () => {
    const harness = createHarness();
    harness.serve(10);
    let stale = 0;
    for (let seq = 11; seq <= 60; seq += 1) {
      harness.advance(5);
      const served = harness.serve(seq);
      if (served.stale) stale += 1;
      expect(served.response.maxSeq).toBeLessThan(seq);
      if (harness.builds.length > 1) break;
    }
    expect(stale).toBeGreaterThan(10);
    expect(harness.builds).toHaveLength(1);
    expect(harness.refreshes).toEqual([]);
    harness.advance(400);
    expect(harness.refreshes).toEqual(["thread-1"]);
    const fresh = harness.serve(61);
    expect(fresh.stale).toBe(false);
    expect(fresh.response.maxSeq).toBe(61);
    expect(harness.builds).toEqual([10, 61]);
  });

  it("schedules a single trailing refresh per snapshot", () => {
    const harness = createHarness();
    harness.serve(10);
    for (let seq = 11; seq <= 30; seq += 1) {
      harness.advance(1);
      harness.serve(seq);
    }
    harness.advance(1_000);
    expect(harness.refreshes).toEqual(["thread-1"]);
  });

  it("builds every time when coalescing is off or the build is cheap", () => {
    const harness = createHarness();
    harness.serve(10);
    harness.advance(1);
    expect(harness.serve(11, { coalesce: false }).stale).toBe(false);
    const cheap = createHarness({ buildMs: 5 });
    cheap.serve(10);
    cheap.advance(1);
    expect(cheap.serve(11).stale).toBe(false);
    expect(cheap.builds).toEqual([10, 11]);
  });

  it("rebuilds when maxSeq regresses", () => {
    const harness = createHarness();
    harness.serve(10);
    harness.advance(1);
    const served = harness.serve(5);
    expect(served.stale).toBe(false);
    expect(served.response.maxSeq).toBe(5);
  });

  it("drops snapshots and trailing refreshes on invalidation", () => {
    const harness = createHarness();
    harness.serve(10);
    harness.advance(1);
    expect(harness.serve(11).stale).toBe(true);
    harness.coalescer.invalidateThread("thread-1");
    expect(harness.coalescer.size).toBe(0);
    expect(harness.coalescer.bytes).toBe(0);
    expect(harness.refreshes).toEqual(["thread-1"]);
    harness.advance(1_000);
    expect(harness.refreshes).toEqual(["thread-1"]);
    const fresh = harness.serve(11);
    expect(fresh.stale).toBe(false);
    expect(fresh.response.maxSeq).toBe(11);
  });

  it("fires the refresh immediately when a stale snapshot is evicted", () => {
    const harness = createHarness({ maxEntries: 2 });
    harness.serve(10, { paramsKey: "a", threadId: "thread-a" });
    harness.advance(1);
    expect(
      harness.serve(11, { paramsKey: "a", threadId: "thread-a" }).stale,
    ).toBe(true);
    expect(harness.refreshes).toEqual([]);
    harness.serve(10, { paramsKey: "b", threadId: "thread-b" });
    harness.serve(10, { paramsKey: "c", threadId: "thread-c" });
    expect(harness.refreshes).toEqual(["thread-a"]);
    harness.advance(1_000);
    expect(harness.refreshes).toEqual(["thread-a"]);
  });

  it("fires the refresh immediately when a stale snapshot is replaced", () => {
    const harness = createHarness();
    harness.serve(10);
    harness.advance(1);
    expect(harness.serve(11).stale).toBe(true);
    expect(harness.refreshes).toEqual([]);
    harness.advance(1);
    const fresh = harness.serve(12, { coalesce: false });
    expect(fresh.response.maxSeq).toBe(12);
    expect(harness.refreshes).toEqual(["thread-1"]);
    harness.advance(1_000);
    expect(harness.refreshes).toEqual(["thread-1"]);
  });

  it("counts bytes as UTF-8 bytes", () => {
    const harness = createHarness();
    const text = "é".repeat(100);
    harness.coalescer.serve({
      build: () =>
        ({ maxSeq: 1, rows: [text] }) as unknown as ThreadTimelineResponse,
      coalesce: false,
      maxSeq: 1,
      paramsKey: "utf8",
      threadId: "thread-1",
    });
    expect(harness.coalescer.bytes).toBe(
      Buffer.byteLength(JSON.stringify({ maxSeq: 1, rows: [text] }), "utf8"),
    );
    expect(harness.coalescer.bytes).toBeGreaterThan(
      JSON.stringify({ maxSeq: 1, rows: [text] }).length,
    );
  });

  it("invalidates only the named thread", () => {
    const harness = createHarness();
    harness.serve(10, { paramsKey: "a", threadId: "thread-a" });
    harness.serve(10, { paramsKey: "b", threadId: "thread-b" });
    harness.coalescer.invalidateThread("thread-a");
    expect(harness.coalescer.size).toBe(1);
  });

  it("bounds entries and bytes with least recently used eviction", () => {
    const entries = createHarness({ maxEntries: 2 });
    for (const key of ["a", "b", "c"]) {
      entries.serve(10, { paramsKey: key, threadId: key });
    }
    expect(entries.coalescer.size).toBe(2);
    entries.serve(10, { paramsKey: "a", threadId: "a" });
    expect(entries.builds).toHaveLength(4);

    const bytes = createHarness({ maxBytes: 1 });
    bytes.serve(10);
    expect(bytes.coalescer.size).toBe(0);
    expect(bytes.coalescer.bytes).toBe(0);
  });
});
