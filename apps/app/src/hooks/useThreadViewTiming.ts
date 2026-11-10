import { useEffect, useLayoutEffect, useRef } from "react";
import { isDocumentVisible } from "../lib/document-visibility";
import {
  clientTimingHiddenCount,
  markThreadViewed,
  recordClientTiming,
} from "../lib/client-timing";

interface ThreadViewTimingEntry {
  threadId: string;
  start: number;
  cached: boolean;
  hiddenCount: number;
  skip: boolean;
  done: boolean;
}

export function useThreadViewTiming(threadId: string, ready: boolean): void {
  const entryRef = useRef<ThreadViewTimingEntry | null>(null);
  useEffect(() => markThreadViewed(threadId), [threadId]);
  useLayoutEffect(() => {
    let entry = entryRef.current;
    if (entry === null || entry.threadId !== threadId) {
      entry = {
        threadId,
        start: performance.now(),
        cached: ready,
        hiddenCount: clientTimingHiddenCount(),
        skip: !isDocumentVisible(),
        done: false,
      };
      entryRef.current = entry;
    }
    if (!ready || entry.done || entry.skip) return;
    const current = entry;
    const frame = requestAnimationFrame(() => {
      if (current.done) return;
      current.done = true;
      if (current.hiddenCount !== clientTimingHiddenCount()) return;
      recordClientTiming(
        "thread-view",
        performance.now() - current.start,
        current.cached,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [threadId, ready]);
}
