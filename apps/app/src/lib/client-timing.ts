import type {
  ClientTimingKind,
  ClientTimingSample,
  RecordClientTimingRequest,
} from "@bb/server-contract";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "./document-visibility";
import { isInsideNativeShell } from "./native-shell";
import { sdk } from "./sdk";
import { wsManager } from "./ws";

export const CLIENT_TIMING_MAX_QUEUE = 200;
export const CLIENT_TIMING_FLUSH_MS = 30_000;
const MAX_SAMPLE_MS = 600_000;
const STREAM_LAG_MAX_MS = 60_000;
const STREAM_LAG_MIN_GAP_MS = 1_000;
const STREAM_APPLIED_MAX_THREADS = 32;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let queue: ClientTimingSample[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastStreamLagAt = Number.NEGATIVE_INFINITY;
let hiddenCount = 0;
const streamAppliedAt = new Map<string, number>();
let uninstall: (() => void) | null = null;

function clientDevice(): RecordClientTimingRequest["device"] {
  if (isInsideNativeShell()) return "mobile";
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  ) {
    return "mobile";
  }
  return "desktop";
}

function clientSurface(): RecordClientTimingRequest["surface"] {
  if (typeof location === "undefined") return "local";
  return LOCAL_HOSTNAMES.has(location.hostname) ? "local" : "remote";
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushClientTiming();
  }, CLIENT_TIMING_FLUSH_MS);
}

export function recordClientTiming(
  kind: ClientTimingKind,
  ms: number,
  cached?: boolean,
): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_SAMPLE_MS) return;
  if (queue.length >= CLIENT_TIMING_MAX_QUEUE) return;
  const rounded = Math.round(ms * 10) / 10;
  queue.push(
    cached === undefined
      ? { kind, ms: rounded }
      : { kind, ms: rounded, cached },
  );
  scheduleFlush();
}

export function flushClientTiming(keepalive = false): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const samples = queue;
  queue = [];
  void sdk.system
    .experimental_recordClientTiming(
      { device: clientDevice(), surface: clientSurface(), samples },
      keepalive ? { keepalive: true } : undefined,
    )
    .catch(() => undefined);
}

export function clientTimingHiddenCount(): number {
  return hiddenCount;
}

export function noteStreamApplied(threadId: string): void {
  if (!isDocumentVisible()) return;
  const now = performance.now();
  streamAppliedAt.delete(threadId);
  for (const [id, appliedAt] of streamAppliedAt) {
    if (
      now - appliedAt <= STREAM_LAG_MAX_MS &&
      streamAppliedAt.size < STREAM_APPLIED_MAX_THREADS
    ) {
      break;
    }
    streamAppliedAt.delete(id);
  }
  streamAppliedAt.set(threadId, now);
}

export function noteStreamCommitted(threadId: string): void {
  const appliedAt = streamAppliedAt.get(threadId);
  if (appliedAt === undefined) return;
  streamAppliedAt.delete(threadId);
  const now = performance.now();
  const lag = now - appliedAt;
  if (lag > STREAM_LAG_MAX_MS) return;
  if (now - lastStreamLagAt < STREAM_LAG_MIN_GAP_MS) return;
  lastStreamLagAt = now;
  recordClientTiming("stream-lag", lag);
}

export async function timeSendAck<T>(send: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await send();
  recordClientTiming("send-ack", performance.now() - start);
  return result;
}

export function installClientTiming(): () => void {
  if (uninstall !== null) return uninstall;
  const stopRoundTrip = wsManager.onRoundTrip((ms) => {
    recordClientTiming("rtt", ms);
  });
  const stopVisibility = subscribeToDocumentVisibility(() => {
    streamAppliedAt.clear();
    if (isDocumentVisible()) return;
    hiddenCount += 1;
    flushClientTiming(true);
  });
  const onPageHide = () => flushClientTiming(true);
  window.addEventListener("pagehide", onPageHide);
  uninstall = () => {
    stopRoundTrip();
    stopVisibility();
    window.removeEventListener("pagehide", onPageHide);
    uninstall = null;
  };
  return uninstall;
}

export function streamAppliedCountForTests(): number {
  return streamAppliedAt.size;
}

export function resetClientTimingForTests(): void {
  uninstall?.();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue = [];
  lastStreamLagAt = Number.NEGATIVE_INFINITY;
  hiddenCount = 0;
  streamAppliedAt.clear();
}
