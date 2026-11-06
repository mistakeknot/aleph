import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ADMISSION_LIMITS,
  measureValue,
  oversizedDedupeKey,
  type OversizedPlaceholder,
} from "../src/admission.js";
import {
  openReadonlyConnection,
  type OpenStoreOptions,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  chunked,
  generatedChunks,
  newSeamStats,
  splitLines,
} from "./support/line-seam.js";
import {
  batchOf,
  cleanupStoreDirs,
  fakeMemory,
  makeStoreDir,
  message,
  source,
  openTestStore,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;
const MIB = 1024 * 1024;
const open: SessionSearchStore[] = [];

function track(dir: string, options?: OpenStoreOptions): SessionSearchStore {
  const store = openTestStore(dir, options);
  open.push(store);
  return store;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  cleanupStoreDirs();
});

function count(dir: string, table: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function placeholderFor(
  generation: number,
  startOffset: number,
  byteLength: number,
): OversizedPlaceholder {
  return {
    kind: "oversized_record",
    dedupeKey: oversizedDedupeKey(generation, startOffset),
    startOffset,
    endOffset: startOffset + byteLength,
    byteLength,
    reason: "record_too_large",
  };
}

describe("measureValue", () => {
  it("accepts a value just under each limit and refuses just over", () => {
    const limits = {
      ...DEFAULT_ADMISSION_LIMITS,
      maxBatchInputBytes: 1000,
      maxBatchAccountedBytes: 100_000,
    };
    expect(measureValue("a".repeat(900), limits).ok).toBe(true);
    const over = measureValue("a".repeat(1001), limits);
    expect(over).toMatchObject({ ok: false, limit: "input_bytes" });
  });

  it("charges two bytes per UTF-16 unit when that exceeds the UTF-8 length", () => {
    const limits = {
      ...DEFAULT_ADMISSION_LIMITS,
      maxBatchInputBytes: 10_000,
      maxBatchAccountedBytes: 2_000,
    };
    const result = measureValue("a".repeat(1000), limits);
    expect(result).toMatchObject({ ok: false, limit: "accounted_bytes" });
  });

  it("stops at the first exceeded limit instead of walking the whole value", () => {
    const limits = {
      ...DEFAULT_ADMISSION_LIMITS,
      maxBatchAccountedBytes: 10_000,
    };
    const huge = Array.from({ length: 5_000_000 }, () => "x");
    const result = measureValue(huge, limits);
    expect(result.ok).toBe(false);
    expect(result.accountedBytes).toBeLessThanOrEqual(10_000 + 1000);
  });

  it("refuses nesting deeper than the depth limit", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) nested = { next: nested };
    expect(measureValue(nested)).toMatchObject({ ok: false, limit: "depth" });
  });

  it("counts buffers at byte length", () => {
    const result = measureValue(Buffer.alloc(1000));
    expect(result.ok && result.inputBytes).toBe(1000);
  });
});

describe("batch admission through the store", () => {
  it("commits a batch under the input ceiling", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const result = store.commitBatch(
      batchOf(source(), [message("a", "q".repeat(3 * MIB), MS)]),
      { expected: null, next: "c1" },
    );
    expect(result.refusal).toBeNull();
    expect(result.committed).toBe(true);
  });

  it("refuses over the input ceiling with no mutation and an unchanged cursor", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    store.commitBatch(batchOf(source(), [message("seed", "seed text", MS)]), {
      expected: null,
      next: "c1",
    });
    const result = store.commitBatch(
      batchOf(source(), [
        message("a", "q".repeat(2 * MIB), MS),
        message("b", "r".repeat(2 * MIB + 1024), MS),
      ]),
      { expected: "c1", next: "c2" },
    );
    expect(result.committed).toBe(false);
    expect(result.refusal?.code).toBe("memory_budget");
    expect(store.suspended).toBeNull();
    store.close();
    open.pop();
    const reopened = track(dir);
    expect(reopened.getCursor(source())).toBe("c1");
    expect(count(dir, "content")).toBe(1);
  });

  it("refuses an accounted size over the ceiling even when input bytes fit", () => {
    const dir = makeStoreDir();
    const store = track(dir, {
      limits: { maxBatchAccountedBytes: 64 * 1024 },
    });
    const result = store.commitBatch(
      batchOf(source(), [message("a", "é".repeat(40_000), MS)]),
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("memory_budget");
    expect(count(dir, "content")).toBe(0);
  });

  it("refuses by record count with batch_too_large", () => {
    const dir = makeStoreDir();
    const store = track(dir, { limits: { maxBatchRecords: 2 } });
    const result = store.commitBatch(
      {
        source: source(),
        records: [message("a", "a", MS), message("b", "b", MS)],
        placeholders: [placeholderFor(1, 0, 10)],
      },
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("batch_too_large");
    expect(store.getCursor(source())).toBeNull();
  });
});

describe("memory admission provider", () => {
  it("refuses without a sample, with a stale sample, and over the ceiling", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    const store = track(dir, { memory: { provider: memory.provider } });
    const attempt = (next: string) =>
      store.commitBatch(
        batchOf(source(), [message(next, "text " + next, MS)]),
        {
          expected: store.getCursor(source()),
          next,
        },
      );

    memory.setSample(null);
    expect(attempt("c1").refusal?.code).toBe("memory_budget");

    memory.setSample({ rssBytes: 1, sampledAtMs: -10_000_000 });
    expect(attempt("c1").refusal?.code).toBe("memory_budget");

    memory.setSample(null);
    memory.setRss(180 * MIB);
    memory.setSample({ rssBytes: 180 * MIB, sampledAtMs: 1_000_000 });
    expect(attempt("c1").refusal?.code).toBe("memory_budget");

    memory.setSample({ rssBytes: 100 * MIB, sampledAtMs: 1_000_000 });
    expect(attempt("c1").committed).toBe(true);
    expect(memory.outstanding()).toBe(0);
  });

  it("refuses when the reservation is not granted", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    memory.deny(true);
    const store = track(dir, { memory: { provider: memory.provider } });
    const result = store.commitBatch(
      batchOf(source(), [message("a", "text", MS)]),
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("memory_budget");
    expect(count(dir, "content")).toBe(0);
  });

  it("reserves at least the minimum plus twice the accounted bytes and releases on every exit", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    const store = track(dir, { memory: { provider: memory.provider } });
    const ok = store.commitBatch(
      batchOf(source(), [message("a", "hello", MS)]),
      { expected: null, next: "c1" },
    );
    expect(ok.committed).toBe(true);
    expect(memory.acquired[0]).toBeGreaterThanOrEqual(32 * MIB);
    expect(memory.outstanding()).toBe(0);

    const conflict = store.commitBatch(
      batchOf(source(), [message("b", "world", MS)]),
      { expected: "wrong", next: "c2" },
    );
    expect(conflict.refusal?.code).toBe("cursor_conflict");
    expect(memory.outstanding()).toBe(0);
  });

  it("releases the reservation when the commit fails inside the transaction", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    const store = track(dir, {
      memory: { provider: memory.provider },
      testHooks: {
        afterApply() {
          throw new Error("boom");
        },
      },
    });
    expect(() =>
      store.commitBatch(batchOf(source(), [message("a", "x", MS)]), {
        expected: null,
        next: "c1",
      }),
    ).toThrow("boom");
    expect(memory.outstanding()).toBe(0);
    expect(count(dir, "content")).toBe(0);
  });

  it("defers vacuum when memory headroom is missing and releases the reservation", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    const store = track(dir, { memory: { provider: memory.provider } });
    memory.setSample(null);
    const deferred = store.reclaim({ force: true });
    expect(deferred.skipped).toBe(true);
    expect(deferred.reason).toBe("memory_deferred");
    expect(store.suspended).toBeNull();
    memory.setRss(64 * MIB);
    memory.setSample({ rssBytes: 64 * MIB, sampledAtMs: 1_000_000 });
    const ran = store.reclaim({ force: true });
    expect(ran.reason).not.toBe("memory_deferred");
    expect(memory.outstanding()).toBe(0);
  });
});

describe("oversized record placeholders", () => {
  it("quarantines with exact offsets, advances the cursor and adds no FTS entry", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const placeholder = placeholderFor(1, 4096, 5 * MIB);
    const result = store.commitBatch(
      { source: source(), records: [], placeholders: [placeholder] },
      { expected: null, next: "c1" },
    );
    expect(result.committed).toBe(true);
    expect(result.quarantined).toBe(1);
    expect(store.getCursor(source())).toBe("c1");
    const db = openReadonlyConnection(dir);
    try {
      const row = db
        .prepare(
          "SELECT dedupe_key, reason, start_offset, end_offset, byte_length FROM quarantine",
        )
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        dedupe_key: placeholder.dedupeKey,
        reason: "record_too_large",
        start_offset: 4096,
        end_offset: 4096 + 5 * MIB,
        byte_length: 5 * MIB,
      });
      expect(
        (db.prepare("SELECT count(*) AS n FROM content").get() as { n: number })
          .n,
      ).toBe(0);
      expect(
        (
          db
            .prepare("SELECT count(*) AS n FROM content_fts('record')")
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps one quarantine row per source when two sources share a generation and offset", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const a = source("source-a");
    const b = source("source-b");
    expect(a.generation).toBe(b.generation);
    const first = store.commitBatch(
      {
        source: a,
        records: [],
        placeholders: [placeholderFor(a.generation, 0, 5 * MIB)],
      },
      { expected: null, next: "a1" },
    );
    const second = store.commitBatch(
      {
        source: b,
        records: [],
        placeholders: [placeholderFor(b.generation, 0, 7 * MIB)],
      },
      { expected: null, next: "b1" },
    );
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(true);
    expect(store.getCursor(a)).toBe("a1");
    expect(store.getCursor(b)).toBe("b1");
    const db = openReadonlyConnection(dir);
    try {
      const rows = db
        .prepare(
          "SELECT s.source_key AS source_key, q.byte_length AS byte_length FROM quarantine q JOIN source_generation s ON s.id = q.source_id ORDER BY s.source_key",
        )
        .all();
      expect(rows).toEqual([
        { source_key: a.key, byte_length: 5 * MIB },
        { source_key: b.key, byte_length: 7 * MIB },
      ]);
    } finally {
      db.close();
    }
  });

  it("indexes the next record after a placeholder and replays idempotently", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const placeholder = placeholderFor(1, 0, 5 * MIB);
    const batch = {
      source: source(),
      records: [message("after", "needle after placeholder", MS)],
      placeholders: [placeholder],
    };
    const first = store.commitBatch(batch, { expected: null, next: "c1" });
    expect(first.inserted).toBe(1);
    expect(first.quarantined).toBe(1);
    const replay = store.commitBatch(batch, { expected: "c1", next: "c1" });
    expect(replay.committed).toBe(true);
    expect(replay.replayed).toBe(1);
    expect(count(dir, "quarantine")).toBe(1);
    expect(count(dir, "content")).toBe(1);
  });

  it("refuses a malformed or mismatched placeholder without mutation", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const good = placeholderFor(1, 10, 100);
    const cases: OversizedPlaceholder[] = [
      { ...good, dedupeKey: "oversized:9:10" },
      { ...good, byteLength: 99 },
      { ...good, endOffset: 5 },
      { ...good, reason: "other" as "record_too_large" },
    ];
    for (const bad of cases) {
      const result = store.commitBatch(
        { source: source(), records: [], placeholders: [bad] },
        { expected: null, next: "c1" },
      );
      expect(result.refusal?.code).toBe("invalid_batch");
    }
    expect(count(dir, "quarantine")).toBe(0);
    expect(store.getCursor(source())).toBeNull();
  });

  it("rolls back the quarantine row and cursor together when the commit fails", () => {
    const dir = makeStoreDir();
    let fail = true;
    const store = track(dir, {
      testHooks: {
        afterApply() {
          if (fail) throw new Error("rollback");
        },
      },
    });
    const placeholder = placeholderFor(1, 0, 5 * MIB);
    expect(() =>
      store.commitBatch(
        { source: source(), records: [], placeholders: [placeholder] },
        { expected: null, next: "c1" },
      ),
    ).toThrow("rollback");
    expect(count(dir, "quarantine")).toBe(0);
    expect(store.getCursor(source())).toBeNull();
    fail = false;
    const retry = store.commitBatch(
      { source: source(), records: [], placeholders: [placeholder] },
      { expected: null, next: "c1" },
    );
    expect(retry.committed).toBe(true);
    expect(count(dir, "quarantine")).toBe(1);
  });

  it("leaves everything unchanged when memory admission refuses a placeholder batch", () => {
    const dir = makeStoreDir();
    const memory = fakeMemory();
    memory.deny(true);
    const store = track(dir, { memory: { provider: memory.provider } });
    const result = store.commitBatch(
      {
        source: source(),
        records: [],
        placeholders: [placeholderFor(1, 0, 5 * MIB)],
      },
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("memory_budget");
    expect(count(dir, "quarantine")).toBe(0);
    expect(store.getCursor(source())).toBeNull();
  });
});

describe("5 MiB line seam", () => {
  it("never retains more than the record cap and indexes the lines around it", async () => {
    const first = JSON.stringify({ text: "needle before the long line" });
    const last = JSON.stringify({ text: "needle after the long line" });
    const stats = newSeamStats();
    const records = [];
    const placeholders: OversizedPlaceholder[] = [];
    let parsed = 0;
    for await (const item of splitLines(
      generatedChunks(
        [
          { kind: "text", text: `${first}\n` },
          { kind: "fill", byte: 0x78, bytes: 5 * MIB },
          { kind: "text", text: `\n${last}\n` },
        ],
        64 * 1024,
      ),
      1,
      DEFAULT_ADMISSION_LIMITS.maxBatchInputBytes,
      stats,
    )) {
      if (item.kind === "placeholder") placeholders.push(item.placeholder);
      else {
        parsed += 1;
        records.push(
          message(
            `line-${item.startOffset}`,
            (JSON.parse(item.text) as { text: string }).text,
            MS + item.startOffset,
          ),
        );
      }
    }
    expect(parsed).toBe(2);
    expect(stats.decodedLines).toBe(2);
    expect(stats.largestDecodedBytes).toBeLessThanOrEqual(
      Math.max(first.length, last.length),
    );
    expect(stats.chunks).toBeGreaterThan(80);
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(
      DEFAULT_ADMISSION_LIMITS.maxBatchInputBytes,
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]!.startOffset).toBe(first.length + 1);
    expect(placeholders[0]!.byteLength).toBe(5 * MIB);
    expect(records).toHaveLength(2);

    const dir = makeStoreDir();
    const store = track(dir);
    const result = store.commitBatch(
      { source: source(), records, placeholders },
      { expected: null, next: "end" },
    );
    expect(result.committed).toBe(true);
    expect(result.inserted).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(count(dir, "content")).toBe(2);
    expect(count(dir, "quarantine")).toBe(1);
  });

  it("counts a line exactly at the cap as a record and one byte over as a placeholder", async () => {
    const cap = 1024;
    const exact = Buffer.from(
      "a".repeat(cap) + "\n" + "b".repeat(cap + 1) + "\n",
    );
    const stats = newSeamStats();
    const kinds: string[] = [];
    for await (const item of splitLines(chunked(exact, 100), 1, cap, stats)) {
      kinds.push(item.kind);
    }
    expect(kinds).toEqual(["line", "placeholder"]);
    expect(stats.peakRetainedBytes).toBe(cap);
  });
});
