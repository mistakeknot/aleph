import type { ThreadTimelineResponse } from "@bb/server-contract";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 32_000_000;
const DEFAULT_MIN_BUILD_MS = 50;
const DEFAULT_MIN_WINDOW_MS = 250;
const DEFAULT_MAX_WINDOW_MS = 500;
const DEFAULT_WINDOW_BUILD_MULTIPLIER = 4;

type CancelTimer = () => void;

interface TimelineBuildCoalescerOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxWindowMs?: number;
  minBuildMs?: number;
  minWindowMs?: number;
  now?: () => number;
  onTrailingRefresh: (threadId: string) => void;
  schedule?: (run: () => void, delayMs: number) => CancelTimer;
  windowBuildMultiplier?: number;
}

interface TimelineBuildCoalescerServeArgs {
  build: () => ThreadTimelineResponse;
  coalesce: boolean;
  maxSeq: number;
  paramsKey: string;
  threadId: string;
}

export interface TimelineBuildCoalescerServeResult {
  response: ThreadTimelineResponse;
  stale: boolean;
}

interface TimelineBuildCoalescer {
  invalidateThread(threadId: string): void;
  serve(
    args: TimelineBuildCoalescerServeArgs,
  ): TimelineBuildCoalescerServeResult;
  readonly bytes: number;
  readonly size: number;
}

interface CoalescerEntry {
  builtAt: number;
  bytes: number;
  buildMs: number;
  cancelTrailing: CancelTimer | null;
  maxSeq: number;
  response: ThreadTimelineResponse;
  threadId: string;
}

export function createTimelineBuildCoalescer(
  options: TimelineBuildCoalescerOptions,
): TimelineBuildCoalescer {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const minBuildMs = options.minBuildMs ?? DEFAULT_MIN_BUILD_MS;
  const minWindowMs = options.minWindowMs ?? DEFAULT_MIN_WINDOW_MS;
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
  const multiplier =
    options.windowBuildMultiplier ?? DEFAULT_WINDOW_BUILD_MULTIPLIER;
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const entries = new Map<string, CoalescerEntry>();
  let totalBytes = 0;

  function windowMs(entry: CoalescerEntry): number {
    return Math.min(
      maxWindowMs,
      Math.max(minWindowMs, entry.buildMs * multiplier),
    );
  }

  function remove(paramsKey: string, refreshThreads: Set<string> | null): void {
    const entry = entries.get(paramsKey);
    if (entry === undefined) return;
    entries.delete(paramsKey);
    totalBytes -= entry.bytes;
    if (entry.cancelTrailing !== null) {
      entry.cancelTrailing();
      entry.cancelTrailing = null;
      refreshThreads?.add(entry.threadId);
    }
  }

  function flush(refreshThreads: Set<string>): void {
    for (const threadId of refreshThreads) {
      options.onTrailingRefresh(threadId);
    }
  }

  function store(paramsKey: string, entry: CoalescerEntry): void {
    const refreshThreads = new Set<string>();
    remove(paramsKey, refreshThreads);
    if (entry.bytes <= maxBytes) {
      entries.set(paramsKey, entry);
      totalBytes += entry.bytes;
      while (entries.size > maxEntries || totalBytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest, refreshThreads);
      }
    }
    flush(refreshThreads);
  }

  function touch(paramsKey: string, entry: CoalescerEntry): void {
    entries.delete(paramsKey);
    entries.set(paramsKey, entry);
  }

  return {
    get bytes() {
      return totalBytes;
    },
    invalidateThread(threadId) {
      for (const [paramsKey, entry] of [...entries]) {
        if (entry.threadId === threadId) remove(paramsKey, null);
      }
    },
    serve(args) {
      const entry = entries.get(args.paramsKey);
      const current = now();
      if (entry !== undefined && entry.threadId === args.threadId) {
        if (entry.maxSeq === args.maxSeq) {
          touch(args.paramsKey, entry);
          return { response: entry.response, stale: false };
        }
        const remaining = windowMs(entry) - (current - entry.builtAt);
        if (
          args.coalesce &&
          args.maxSeq > entry.maxSeq &&
          entry.buildMs >= minBuildMs &&
          remaining > 0
        ) {
          touch(args.paramsKey, entry);
          if (entry.cancelTrailing === null) {
            const threadId = args.threadId;
            entry.cancelTrailing = schedule(() => {
              entry.cancelTrailing = null;
              options.onTrailingRefresh(threadId);
            }, remaining);
          }
          return { response: entry.response, stale: true };
        }
      }
      const startedAt = now();
      const response = args.build();
      const finishedAt = now();
      store(args.paramsKey, {
        buildMs: finishedAt - startedAt,
        builtAt: finishedAt,
        bytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
        cancelTrailing: null,
        maxSeq: args.maxSeq,
        response,
        threadId: args.threadId,
      });
      return { response, stale: false };
    },
    get size() {
      return entries.size;
    },
  };
}
