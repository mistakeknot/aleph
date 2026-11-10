import { constants, PerformanceObserver } from "node:perf_hooks";
import type { PerformanceEntry } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";

export type GcKind = "minor" | "major" | "incremental" | "weakcb" | "other";

export interface GcKindSummary {
  count: number;
  durationMs: number;
  maxDurationMs: number;
}

export interface GcWindowSummary {
  gcCount: number;
  gcDurationMs: number;
  gcMaxDurationMs: number;
  gcMaxKind: GcKind | null;
  gcByKind: Partial<Record<GcKind, GcKindSummary>>;
}

export interface GcWindow {
  take: () => GcWindowSummary;
  stop: () => void;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

function gcKindOf(entry: PerformanceEntry): GcKind {
  const kind = (entry as PerformanceEntry & { detail?: { kind?: number } })
    .detail?.kind;
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MINOR:
      return "minor";
    case constants.NODE_PERFORMANCE_GC_MAJOR:
      return "major";
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return "incremental";
    case constants.NODE_PERFORMANCE_GC_WEAKCB:
      return "weakcb";
    default:
      return "other";
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MEGABYTE) * 10) / 10;
}

export function startGcWindowObserver(): GcWindow {
  let gcCount = 0;
  let gcDurationMs = 0;
  let gcMaxDurationMs = 0;
  let gcMaxKind: GcKind | null = null;
  let gcByKind: Partial<Record<GcKind, GcKindSummary>> = {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = gcKindOf(entry);
      gcCount += 1;
      gcDurationMs += entry.duration;
      if (entry.duration > gcMaxDurationMs) {
        gcMaxDurationMs = entry.duration;
        gcMaxKind = kind;
      }
      const summary = (gcByKind[kind] ??= {
        count: 0,
        durationMs: 0,
        maxDurationMs: 0,
      });
      summary.count += 1;
      summary.durationMs += entry.duration;
      summary.maxDurationMs = Math.max(summary.maxDurationMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return {
    take: () => {
      const byKind: Partial<Record<GcKind, GcKindSummary>> = {};
      for (const [kind, summary] of Object.entries(gcByKind)) {
        byKind[kind as GcKind] = {
          count: summary.count,
          durationMs: roundMs(summary.durationMs),
          maxDurationMs: roundMs(summary.maxDurationMs),
        };
      }
      const result: GcWindowSummary = {
        gcCount,
        gcDurationMs: roundMs(gcDurationMs),
        gcMaxDurationMs: roundMs(gcMaxDurationMs),
        gcMaxKind,
        gcByKind: byKind,
      };
      gcCount = 0;
      gcDurationMs = 0;
      gcMaxDurationMs = 0;
      gcMaxKind = null;
      gcByKind = {};
      return result;
    },
    stop: () => observer.disconnect(),
  };
}

export interface HeapSummary {
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
  heapUsedOfLimit: number;
  externalMb: number;
  mallocedMb: number;
  nativeContexts: number;
  detachedContexts: number;
}

export function takeHeapSummary(): HeapSummary {
  const heap = getHeapStatistics();
  return {
    heapUsedMb: roundMb(heap.used_heap_size),
    heapTotalMb: roundMb(heap.total_heap_size),
    heapLimitMb: roundMb(heap.heap_size_limit),
    heapUsedOfLimit:
      heap.heap_size_limit === 0
        ? 0
        : Math.round((heap.used_heap_size / heap.heap_size_limit) * 1000) /
          1000,
    externalMb: roundMb(heap.external_memory),
    mallocedMb: roundMb(heap.malloced_memory),
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
  };
}

export function takeHeapSpaceSummary(): Record<
  string,
  { usedMb: number; sizeMb: number }
> {
  const spaces: Record<string, { usedMb: number; sizeMb: number }> = {};
  for (const space of getHeapSpaceStatistics()) {
    spaces[space.space_name] = {
      usedMb: roundMb(space.space_used_size),
      sizeMb: roundMb(space.space_size),
    };
  }
  return spaces;
}
