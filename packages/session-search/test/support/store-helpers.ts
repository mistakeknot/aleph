import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MemoryAdmissionProvider,
  MemorySample,
} from "../../src/admission.js";
import type {
  MessageRecord,
  ToolCallRecord,
  ToolResultRecord,
} from "../../src/contracts.js";
import type {
  CommitBatch,
  CursorUpdate,
  SessionSearchStore,
  SourceRef,
} from "../../src/storage.js";

const cleanups: string[] = [];

export function makeStoreDir(prefix = "ss-store-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  return join(root, "store");
}

export function cleanupStoreDirs(): void {
  while (cleanups.length > 0) {
    const root = cleanups.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
}

export function source(
  key = "src-a",
  generation = 1,
  at = 1_700_000_000_000,
): SourceRef {
  return { key, generation, discoveredAtMs: at };
}

export function message(
  id: string,
  text: string,
  eventTimeMs: number | null,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    kind: "message",
    provider: "claude",
    sessionId: "s1",
    agentId: null,
    sidechain: false,
    parentCallId: null,
    cwd: "/work/fixture",
    eventTimeMs,
    dedupeKey: `fx:${id}`,
    role: "user",
    text,
    ...overrides,
  };
}

export function toolCall(
  id: string,
  name: string,
  argumentsText: string,
  eventTimeMs: number | null,
  touches: ToolCallRecord["touches"] = [],
): ToolCallRecord {
  return {
    kind: "tool_call",
    provider: "claude",
    sessionId: "s1",
    agentId: null,
    sidechain: false,
    parentCallId: null,
    cwd: "/work/fixture",
    eventTimeMs,
    dedupeKey: `fx:${id}`,
    callId: `call-${id}`,
    name,
    argumentsText,
    touches,
    delegation: false,
  };
}

export function toolResult(
  id: string,
  text: string,
  eventTimeMs: number | null,
): ToolResultRecord {
  return {
    kind: "tool_result",
    provider: "claude",
    sessionId: "s1",
    agentId: null,
    sidechain: false,
    parentCallId: null,
    cwd: "/work/fixture",
    eventTimeMs,
    dedupeKey: `fx:${id}`,
    callId: `call-${id}`,
    text,
  };
}

export function batchOf(
  src: SourceRef,
  records: CommitBatch["records"],
): CommitBatch {
  return { source: src, records };
}

export function nextCursor(
  store: SessionSearchStore,
  src: SourceRef,
  next: string,
): CursorUpdate {
  return { expected: store.getCursor(src), next };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
  "refactor",
  "storage",
  "session",
  "cursor",
];

export function fixtureText(random: () => number, words: number): string {
  const out: string[] = [];
  for (let index = 0; index < words; index += 1) {
    out.push(WORDS[Math.floor(random() * WORDS.length)]!);
  }
  return out.join(" ");
}

export interface FakeMemory {
  provider: MemoryAdmissionProvider;
  setRss(bytes: number): void;
  setSample(sample: MemorySample | null): void;
  advance(ms: number): void;
  deny(value: boolean): void;
  readonly acquired: number[];
  readonly outstanding: () => number;
}

export function fakeMemory(rssBytes = 64 * 1024 * 1024): FakeMemory {
  let now = 1_000_000;
  let rss = rssBytes;
  let sample: MemorySample | null | "live" = "live";
  let denied = false;
  let open = 0;
  const acquired: number[] = [];
  const provider: MemoryAdmissionProvider = {
    clock: () => now,
    sample: () =>
      sample === "live" ? { rssBytes: rss, sampledAtMs: now } : sample,
    acquire: (bytes) => {
      if (denied) return null;
      acquired.push(bytes);
      open += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          open -= 1;
        },
      };
    },
  };
  return {
    provider,
    setRss(bytes) {
      rss = bytes;
    },
    setSample(next) {
      sample = next === null ? null : next;
    },
    advance(ms) {
      now += ms;
    },
    deny(value) {
      denied = value;
    },
    acquired,
    outstanding: () => open,
  };
}
