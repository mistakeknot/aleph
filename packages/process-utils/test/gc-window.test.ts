import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  startGcWindowObserver,
  takeHeapSpaceSummary,
  takeHeapSummary,
} from "../src/gc-window.js";

function churn(): number {
  let total = 0;
  for (let round = 0; round < 200; round += 1) {
    const garbage = Array.from({ length: 5_000 }, (_, index) => ({
      index,
      text: `item-${index}-${round}`,
    }));
    total += garbage.length;
  }
  return total;
}

describe("GC window observer", () => {
  it("counts main-thread GC pauses by kind and resets on take", async () => {
    const window = startGcWindowObserver();
    try {
      expect(churn()).toBeGreaterThan(0);
      let summary = window.take();
      for (let attempt = 0; summary.gcCount === 0 && attempt < 20; attempt++) {
        await delay(10);
        summary = window.take();
      }
      expect(summary.gcCount).toBeGreaterThan(0);
      expect(summary.gcDurationMs).toBeGreaterThanOrEqual(
        summary.gcMaxDurationMs,
      );
      expect(summary.gcMaxKind).not.toBeNull();
      const byKindCount = Object.values(summary.gcByKind).reduce(
        (sum, kind) => sum + kind.count,
        0,
      );
      expect(byKindCount).toBe(summary.gcCount);
      expect(window.take()).toEqual({
        gcCount: 0,
        gcDurationMs: 0,
        gcMaxDurationMs: 0,
        gcMaxKind: null,
        gcByKind: {},
      });
    } finally {
      window.stop();
    }
  });

  it("reports heap totals against the configured limit and per-space sizes", () => {
    const heap = takeHeapSummary();
    expect(heap.heapLimitMb).toBeGreaterThan(0);
    expect(heap.heapUsedMb).toBeGreaterThan(0);
    expect(heap.heapUsedMb).toBeLessThanOrEqual(heap.heapTotalMb);
    expect(heap.heapUsedOfLimit).toBeGreaterThan(0);
    expect(heap.heapUsedOfLimit).toBeLessThan(1);
    const spaces = takeHeapSpaceSummary();
    expect(spaces).toHaveProperty("old_space");
    expect(spaces.old_space!.usedMb).toBeLessThanOrEqual(
      spaces.old_space!.sizeMb,
    );
  });
});
