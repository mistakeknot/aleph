import { constants, performance, PerformanceObserver } from "node:perf_hooks";
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
  take: (untilMs?: number) => GcWindowSummary;
  stop: () => void;
}

interface GcPause {
  startTime: number;
  duration: number;
  kind: GcKind;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const MAX_PENDING_GC_PAUSES = 4096;

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

function summarizeGcPauses(pauses: readonly GcPause[]): GcWindowSummary {
  let gcDurationMs = 0;
  let gcMaxDurationMs = 0;
  let gcMaxKind: GcKind | null = null;
  const gcByKind: Partial<Record<GcKind, GcKindSummary>> = {};
  for (const pause of pauses) {
    gcDurationMs += pause.duration;
    if (pause.duration > gcMaxDurationMs) {
      gcMaxDurationMs = pause.duration;
      gcMaxKind = pause.kind;
    }
    const summary = (gcByKind[pause.kind] ??= {
      count: 0,
      durationMs: 0,
      maxDurationMs: 0,
    });
    summary.count += 1;
    summary.durationMs += pause.duration;
    summary.maxDurationMs = Math.max(summary.maxDurationMs, pause.duration);
  }
  for (const summary of Object.values(gcByKind)) {
    summary.durationMs = roundMs(summary.durationMs);
    summary.maxDurationMs = roundMs(summary.maxDurationMs);
  }
  return {
    gcCount: pauses.length,
    gcDurationMs: roundMs(gcDurationMs),
    gcMaxDurationMs: roundMs(gcMaxDurationMs),
    gcMaxKind,
    gcByKind,
  };
}

export function startGcWindowObserver(): GcWindow {
  let pending: GcPause[] = [];
  const add = (entries: readonly PerformanceEntry[]) => {
    for (const entry of entries) {
      pending.push({
        startTime: entry.startTime,
        duration: entry.duration,
        kind: gcKindOf(entry),
      });
    }
    if (pending.length > MAX_PENDING_GC_PAUSES) {
      pending = pending.slice(-MAX_PENDING_GC_PAUSES);
    }
  };
  const observer = new PerformanceObserver((list) => add(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  return {
    take: (untilMs = performance.now()) => {
      add(observer.takeRecords());
      const inWindow: GcPause[] = [];
      const later: GcPause[] = [];
      for (const pause of pending) {
        (pause.startTime < untilMs ? inWindow : later).push(pause);
      }
      pending = later;
      return summarizeGcPauses(inWindow);
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
