import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionRecord, UsageRecord } from "../src/contracts.js";
import { modeOf, StoreSecurityError } from "../src/private-fs.js";
import { composeRowid } from "../src/rowid.js";
import {
  openReadonlyConnection,
  openStore,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  makeStoreDir,
  message,
  source,
  toolCall,
  toolResult,
} from "./support/store-helpers.js";

const open: SessionSearchStore[] = [];

function openTracked(
  dir: string,
  options?: Parameters<typeof openStore>[1],
): SessionSearchStore {
  const store = openStore(dir, options);
  open.push(store);
  return store;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  cleanupStoreDirs();
});

function rows<T>(dir: string, sql: string, ...params: unknown[]): T[] {
  const db = openReadonlyConnection(dir);
  try {
    return db
      .prepare(sql)
      .safeIntegers(true)
      .all(...params) as T[];
  } finally {
    db.close();
  }
}

const MS = 1_700_000_000_000;

describe("time-keyed rowids", () => {
  it("composes event_ms * 2^20 + counter as exact BigInt values", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source();
    const result = store.commitBatch(
      batchOf(src, [
        message("a", "first alpha", MS),
        message("b", "second bravo", MS),
        message("c", "third charlie", MS + 1),
      ]),
      { expected: null, next: "c1" },
    );
    expect(result.committed).toBe(true);
    expect(result.inserted).toBe(3);
    const ids = result.entries.map((entry) => BigInt(entry.rowid!));
    expect(ids).toEqual([
      composeRowid(BigInt(MS), 0n),
      composeRowid(BigInt(MS), 1n),
      composeRowid(BigInt(MS + 1), 0n),
    ]);
    expect(BigInt(MS) * 1048576n + 1n).toBe(ids[1]);
    expect(ids[1]! > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    const stored = rows<{ id: bigint; event_ms: bigint }>(
      dir,
      "SELECT id, event_ms FROM content ORDER BY id",
    );
    expect(stored.map((row) => row.id)).toEqual(ids);
    expect(stored.every((row) => row.id >> 20n === row.event_ms)).toBe(true);
  });

  it("holds the largest representable millisecond exactly", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const maxMs = 2 ** 43 - 1;
    const result = store.commitBatch(
      batchOf(source("max", 1, maxMs), [message("m", "edge", maxMs)]),
      { expected: null, next: "c1" },
    );
    expect(result.inserted).toBe(1);
    expect(BigInt(result.entries[0]!.rowid!)).toBe(
      composeRowid(BigInt(maxMs), 0n),
    );
    expect(BigInt(result.entries[0]!.rowid!) < 2n ** 63n).toBe(true);
  });

  it("allocates counters across sources for the same millisecond", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const first = store.commitBatch(
      batchOf(source("one"), [message("x1", "from one", MS)]),
      { expected: null, next: "c1" },
    );
    const second = store.commitBatch(
      batchOf(source("two"), [message("x2", "from two", MS)]),
      { expected: null, next: "c1" },
    );
    expect(BigInt(first.entries[0]!.rowid!)).toBe(composeRowid(BigInt(MS), 0n));
    expect(BigInt(second.entries[0]!.rowid!)).toBe(
      composeRowid(BigInt(MS), 1n),
    );
  });

  it("quarantines a record when the millisecond counter is exhausted", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source();
    store.commitBatch(batchOf(src, [message("seed", "seed", MS + 5)]), {
      expected: null,
      next: "c0",
    });
    const second = new Database(join(dir, "session-search.sqlite3"));
    second.pragma("busy_timeout = 5000");
    second
      .prepare("INSERT INTO ms_counter(event_ms, next_counter) VALUES (?, ?)")
      .run(MS, 1048575);
    second.close();
    const result = store.commitBatch(
      batchOf(src, [message("o1", "fits", MS), message("o2", "overflows", MS)]),
      { expected: "c0", next: "c1" },
    );
    expect(result.committed).toBe(true);
    expect(result.inserted).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(result.entries[1]).toMatchObject({
      outcome: "quarantined",
      reason: "counter_overflow",
      rowid: null,
    });
    expect(BigInt(result.entries[0]!.rowid!)).toBe(
      composeRowid(BigInt(MS), 1048575n),
    );
    expect(store.getCursor(src)).toBe("c1");
    const quarantined = rows<{ dedupe_key: string; reason: string }>(
      dir,
      "SELECT dedupe_key, reason FROM quarantine",
    );
    expect(quarantined).toEqual([
      { dedupe_key: "fx:o2", reason: "counter_overflow" },
    ]);
  });

  it("labels a missing event time as discovery time and keeps the first discovery", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source("disc", 1, MS - 1000);
    const first = store.commitBatch(
      batchOf(src, [message("d1", "undated record", null)]),
      { expected: null, next: "c1" },
    );
    expect(first.entries[0]!.timeBasis).toBe("discovery");
    expect(BigInt(first.entries[0]!.rowid!) >> 20n).toBe(BigInt(MS - 1000));
    const later = store.commitBatch(
      batchOf({ ...src, discoveredAtMs: MS + 99_999 }, [
        message("d2", "another undated record", null),
      ]),
      { expected: "c1", next: "c2" },
    );
    expect(BigInt(later.entries[0]!.rowid!) >> 20n).toBe(BigInt(MS - 1000));
    expect(store.firstDiscoveryMs(src)).toBe(BigInt(MS - 1000));
    const basis = rows<{ time_basis: string }>(
      dir,
      "SELECT time_basis FROM content ORDER BY id",
    );
    expect(basis.map((row) => row.time_basis)).toEqual([
      "discovery",
      "discovery",
    ]);
  });

  it("falls back to discovery for out-of-range or non-finite times and floors fractions", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const result = store.commitBatch(
      batchOf(source("odd", 1, MS), [
        message("neg", "negative", -5),
        message("big", "too large", 2 ** 43),
        message("nan", "not a number", Number.NaN),
        message("frac", "fractional", MS + 0.75),
      ]),
      { expected: null, next: "c1" },
    );
    expect(result.entries.map((entry) => entry.timeBasis)).toEqual([
      "discovery",
      "discovery",
      "discovery",
      "event",
    ]);
    expect(BigInt(result.entries[3]!.rowid!) >> 20n).toBe(BigInt(MS));
  });

  it("persists the identity mapping and replays without new rows", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source();
    const records = [
      message("r1", "replay one", MS),
      toolCall("r2", "Read", "{}", MS + 1, [
        { path: "/work/a.ts", access: "read", confidence: "structured" },
      ]),
      toolResult("r3", "done", MS + 2),
    ];
    const first = store.commitBatch(batchOf(src, records), {
      expected: null,
      next: "c1",
    });
    store.close();
    open.pop();
    const reopened = openTracked(dir);
    const second = reopened.commitBatch(batchOf(src, records), {
      expected: "c1",
      next: "c2",
    });
    expect(second.replayed).toBe(3);
    expect(second.inserted).toBe(0);
    expect(second.entries.map((entry) => entry.rowid)).toEqual(
      first.entries.map((entry) => entry.rowid),
    );
    expect(reopened.lookupIdentity("fx:r1")?.rowid).toBe(
      BigInt(first.entries[0]!.rowid!),
    );
    expect(
      rows<{ n: bigint }>(dir, "SELECT count(*) AS n FROM content")[0]!.n,
    ).toBe(3n);
  });

  it("re-keys a record whose time is corrected, bumping the epoch", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source("fix", 1, MS);
    const undated = message("t1", "needle haystack", null);
    store.commitBatch(batchOf(src, [undated]), { expected: null, next: "c1" });
    const epochBefore = store.epoch();
    const old = store.lookupIdentity("fx:t1")!;
    expect(old.timeBasis).toBe("discovery");
    const result = store.commitBatch(
      batchOf(src, [{ ...undated, eventTimeMs: MS - 50_000 }]),
      { expected: "c1", next: "c2" },
    );
    expect(result.corrected).toBe(1);
    expect(result.epoch).toBe(epochBefore + 1);
    const fresh = store.lookupIdentity("fx:t1")!;
    expect(fresh.timeBasis).toBe("event");
    expect(fresh.rowid).not.toBe(old.rowid);
    expect(fresh.rowid >> 20n).toBe(BigInt(MS - 50_000));
    const hits = rows<{ rowid: bigint }>(
      dir,
      "SELECT rowid FROM content_fts WHERE content_fts MATCH 'needle'",
    );
    expect(hits).toEqual([{ rowid: fresh.rowid }]);
    expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
  });

  it("updates text in place when the key and time are unchanged", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source();
    store.commitBatch(batchOf(src, [message("u1", "oldterm", MS)]), {
      expected: null,
      next: "c1",
    });
    const result = store.commitBatch(
      batchOf(src, [message("u1", "newterm", MS)]),
      { expected: "c1", next: "c2" },
    );
    expect(result.updated).toBe(1);
    expect(store.epoch()).toBe(0);
    const match = (term: string) =>
      rows(dir, "SELECT rowid FROM content_fts WHERE content_fts MATCH ?", term)
        .length;
    expect(match("oldterm")).toBe(0);
    expect(match("newterm")).toBe(1);
  });
});

describe("cursor and records", () => {
  it("refuses a stale cursor without changing anything", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const src = source();
    store.commitBatch(batchOf(src, [message("s1", "one", MS)]), {
      expected: null,
      next: "c1",
    });
    const result = store.commitBatch(
      batchOf(src, [message("s2", "two", MS + 1)]),
      { expected: null, next: "c9" },
    );
    expect(result.committed).toBe(false);
    expect(result.refusal?.code).toBe("cursor_conflict");
    expect(result.cursor).toBe("c1");
    expect(store.getCursor(src)).toBe("c1");
    expect(store.lookupIdentity("fx:s2")).toBeNull();
    expect(store.suspended).toBeNull();
  });

  it("refuses malformed batches", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const bad = store.commitBatch(
      batchOf({ key: "", generation: 1, discoveredAtMs: MS }, []),
      { expected: null, next: "c1" },
    );
    expect(bad.refusal?.code).toBe("invalid_batch");
    const badTime = store.commitBatch(
      batchOf({ key: "k", generation: 1, discoveredAtMs: -1 }, []),
      { expected: null, next: "c1" },
    );
    expect(badTime.refusal?.code).toBe("invalid_batch");
    const emptyCursor = store.commitBatch(batchOf(source(), []), {
      expected: null,
      next: "",
    });
    expect(emptyCursor.refusal?.code).toBe("invalid_batch");
  });

  it("counts session and usage records as unindexed", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const session: SessionRecord = {
      kind: "session",
      provider: "claude",
      sessionId: "s1",
      agentId: null,
      sidechain: false,
      parentCallId: null,
      cwd: null,
      eventTimeMs: MS,
      dedupeKey: "fx:session",
      model: "m",
    };
    const usage: UsageRecord = {
      kind: "usage",
      provider: "claude",
      sessionId: "s1",
      agentId: null,
      sidechain: false,
      parentCallId: null,
      cwd: null,
      eventTimeMs: MS,
      dedupeKey: "fx:usage",
      basis: "delta",
      origin: "claude-message",
      scopeKey: "s1",
      model: "m",
      inputIncludesCache: null,
      costUsd: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 2,
    };
    const result = store.commitBatch(
      batchOf(source(), [session, usage, message("k", "kept", MS)]),
      { expected: null, next: "c1" },
    );
    expect(result.unindexed).toBe(2);
    expect(result.inserted).toBe(1);
  });

  it("quarantines a record above the per-record text limit", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir, { limits: { maxRecordTextBytes: 1024 } });
    const result = store.commitBatch(
      batchOf(source(), [
        message("big", "x".repeat(2048), MS),
        message("ok", "small", MS),
      ]),
      { expected: null, next: "c1" },
    );
    expect(result.entries[0]).toMatchObject({
      outcome: "quarantined",
      reason: "record_too_large",
    });
    expect(result.inserted).toBe(1);
  });

  it("refuses an oversized batch before writing", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir, { limits: { maxBatchRecords: 2 } });
    const result = store.commitBatch(
      batchOf(source(), [
        message("a", "a", MS),
        message("b", "b", MS),
        message("c", "c", MS),
      ]),
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("batch_too_large");
    expect(store.getCursor(source())).toBeNull();
    expect(store.suspended).toBeNull();
  });
});

describe("exact file filters", () => {
  it("finds tool calls by exact touched path only", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    store.commitBatch(
      batchOf(source(), [
        toolCall("p1", "Read", "{}", MS, [
          { path: "/work/src/a.ts", access: "read", confidence: "structured" },
        ]),
        toolCall("p2", "Edit", "{}", MS + 1, [
          {
            path: "/work/src/a.ts.bak",
            access: "write",
            confidence: "structured",
          },
          { path: "/work/src/b.ts", access: "write", confidence: "inferred" },
        ]),
        toolCall("p3", "Read", "{}", MS + 2, [
          { path: "/work/src/a.ts", access: "read", confidence: "structured" },
        ]),
      ]),
      { expected: null, next: "c1" },
    );
    const keyOf = (rowid: bigint) =>
      store.lookupIdentity("fx:p1")?.rowid === rowid;
    const hits = store.findByTouchedPath("/work/src/a.ts");
    expect(hits).toHaveLength(2);
    expect(hits.some(keyOf)).toBe(true);
    expect(store.findByTouchedPath("/work/src/a")).toEqual([]);
    expect(store.findByTouchedPath("/work/src/a.t")).toEqual([]);
    expect(store.findByTouchedPath("/work/src/b.ts")).toHaveLength(1);
  });
});

describe("search index", () => {
  it("keeps the external-content index consistent through deletes", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    store.commitBatch(
      batchOf(source("gone"), [
        message("g1", "uniqueterm alpha", MS),
        message("g2", "uniqueterm bravo", MS + 1),
      ]),
      { expected: null, next: "c1" },
    );
    store.commitBatch(
      batchOf(source("stay"), [message("s1", "stayterm charlie", MS + 2)]),
      { expected: null, next: "c1" },
    );
    expect(store.integrityCheck().ok).toBe(true);
    expect(store.removeSource("gone", { chunkRows: 1 })).toBe(2);
    expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
    const count = (term: string) =>
      rows(dir, "SELECT rowid FROM content_fts WHERE content_fts MATCH ?", term)
        .length;
    expect(count("uniqueterm")).toBe(0);
    expect(count("stayterm")).toBe(1);
    expect(store.lookupIdentity("fx:g1")).toBeNull();
  });
});

describe("private modes", () => {
  it("creates 0700 directories and 0600 database files", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    store.commitBatch(batchOf(source(), [message("m", "mode", MS)]), {
      expected: null,
      next: "c1",
    });
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "tmp"))).toBe(0o700);
    const db = join(dir, "session-search.sqlite3");
    expect(modeOf(db)).toBe(0o600);
    for (const sidecar of [`${db}-wal`, `${db}-shm`]) {
      if (existsSync(sidecar)) expect(modeOf(sidecar)).toBe(0o600);
    }
  });

  it("tightens loose modes left by an earlier run", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    store.commitBatch(batchOf(source(), [message("m", "mode", MS)]), {
      expected: null,
      next: "c1",
    });
    store.close();
    open.pop();
    const db = join(dir, "session-search.sqlite3");
    chmodSync(dir, 0o755);
    chmodSync(db, 0o644);
    openTracked(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(db)).toBe(0o600);
  });

  it("rejects a symlinked store directory", () => {
    const dir = makeStoreDir();
    const real = `${dir}-real`;
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, dir);
    expect(() => openStore(dir)).toThrow(StoreSecurityError);
    try {
      openStore(dir);
    } catch (error) {
      expect((error as StoreSecurityError).code).toBe("symlink");
    }
  });

  it("rejects a symlinked database file", () => {
    const dir = makeStoreDir();
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, "elsewhere.db");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, join(dir, "session-search.sqlite3"));
    try {
      openStore(dir);
      throw new Error("expected a symlink rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreSecurityError);
      expect((error as StoreSecurityError).code).toBe("symlink");
    }
  });

  it("rejects a database path that is not a regular file", () => {
    const dir = makeStoreDir();
    mkdirSync(join(dir, "session-search.sqlite3"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      openStore(dir);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreSecurityError);
      expect((error as StoreSecurityError).code).toBe("not_regular_file");
    }
  });
});

describe("connection settings", () => {
  it("applies the page, vacuum, temp and mmap settings", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    const settings = store.settings();
    expect(settings).toMatchObject({
      journalMode: "wal",
      autoVacuum: 2,
      pageSize: 4096,
      tempStore: 1,
      cacheSize: -8192,
      mmapSize: 0,
      maxPageCount: 786432,
      foreignKeys: 1,
      userVersion: 1,
    });
    expect(786432 * 4096).toBe(3 * 1024 ** 3);
  });

  it("applies the read-side limits to read-only connections", () => {
    const dir = makeStoreDir();
    openTracked(dir);
    const reader = openReadonlyConnection(dir);
    try {
      expect(reader.pragma("temp_store", { simple: true })).toBe(1);
      expect(reader.pragma("cache_size", { simple: true })).toBe(-8192);
      expect(reader.pragma("mmap_size", { simple: true })).toBe(0);
      expect(() => reader.exec("DELETE FROM content")).toThrow();
    } finally {
      reader.close();
    }
  });
});

describe("physical accounting", () => {
  it("sums database, WAL, shared-memory and temp bytes", () => {
    const dir = makeStoreDir();
    const store = openTracked(dir);
    store.commitBatch(batchOf(source(), [message("m", "bytes", MS)]), {
      expected: null,
      next: "c1",
    });
    const bytes = store.physicalBytes();
    expect(bytes.db).toBeGreaterThan(0);
    expect(bytes.total).toBe(bytes.db + bytes.wal + bytes.shm + bytes.tmp);
    const capacity = store.capacity();
    expect(capacity.pageSize).toBe(4096);
    expect(capacity.freePages).toBeGreaterThan(0);
  });
});
