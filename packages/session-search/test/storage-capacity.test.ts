import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openReadonlyConnection,
  openStore,
  type OpenStoreOptions,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  makeStoreDir,
  message,
  nextCursor,
  source,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;
const KIB = 1024;
const MIB = 1024 * KIB;
const open: SessionSearchStore[] = [];

function track(store: SessionSearchStore): SessionSearchStore {
  open.push(store);
  return store;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  cleanupStoreDirs();
});

function bigRecords(prefix: string, count: number, bytes: number, at: number) {
  const body = "x".repeat(bytes);
  return Array.from({ length: count }, (_, index) =>
    message(`${prefix}-${index}`, `${prefix}${index} ${body}`, at + index),
  );
}

function committedRows(dir: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return (db.prepare("SELECT count(*) AS n FROM content").get() as { n: number })
      .n;
  } finally {
    db.close();
  }
}

describe("atomic rollback on a page-limit failure (SQLITE_FULL)", () => {
  it("rolls back rows, FTS, identities and the cursor together", () => {
    const dir = makeStoreDir();
    let lowered = false;
    const options: OpenStoreOptions = {
      testHooks: {
        afterAdmission(db) {
          if (!lowered) return;
          const pages = db.pragma("page_count", { simple: true }) as number;
          db.pragma(`max_page_count = ${pages + 3}`);
        },
      },
    };
    const store = track(openStore(dir, options));
    const src = source();
    const first = store.commitBatch(
      batchOf(src, [message("ok", "committed before failure", MS)]),
      { expected: null, next: "c1" },
    );
    expect(first.committed).toBe(true);
    const rowsBefore = committedRows(dir);

    lowered = true;
    const result = store.commitBatch(
      batchOf(src, bigRecords("doomed", 40, 8 * KIB, MS + 10)),
      nextCursor(store, src, "c2"),
    );
    expect(result.committed).toBe(false);
    expect(result.refusal?.code).toBe("db_page_limit");
    expect(result.cursor).toBe("c1");
    expect(store.getCursor(src)).toBe("c1");
    expect(store.lookupIdentity("fx:doomed-0")).toBeNull();
    expect(committedRows(dir)).toBe(rowsBefore);
    expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
    const fts = openReadonlyConnection(dir);
    try {
      expect(
        fts
          .prepare("SELECT rowid FROM content_fts WHERE content_fts MATCH 'doomed0'")
          .all(),
      ).toEqual([]);
    } finally {
      fts.close();
    }
    expect(store.suspended?.code).toBe("db_page_limit");

    const refused = store.commitBatch(
      batchOf(src, [message("later", "after suspension", MS + 20)]),
      nextCursor(store, src, "c3"),
    );
    expect(refused.refusal?.code).toBe("suspended");
    expect(store.getCursor(src)).toBe("c1");
  });

  it("recovers on a fresh connection once the cause is gone", () => {
    const dir = makeStoreDir();
    const store = track(
      openStore(dir, {
        testHooks: {
          afterAdmission(db) {
            const pages = db.pragma("page_count", { simple: true }) as number;
            db.pragma(`max_page_count = ${pages + 3}`);
          },
        },
      }),
    );
    const src = source();
    const failed = store.commitBatch(
      batchOf(src, bigRecords("again", 30, 8 * KIB, MS)),
      { expected: null, next: "c1" },
    );
    expect(failed.refusal?.code).toBe("db_page_limit");
    expect(store.suspended?.code).toBe("db_page_limit");
    store.close();
    open.pop();

    const reopened = track(openStore(dir));
    expect(reopened.suspended).toBeNull();
    expect(reopened.getCursor(src)).toBeNull();
    const retry = reopened.commitBatch(
      batchOf(src, [message("small", "fits now", MS)]),
      { expected: null, next: "c1" },
    );
    expect(retry.refusal).toBeNull();
    expect(retry.committed).toBe(true);
    expect(reopened.getCursor(src)).toBe("c1");
    expect(committedRows(dir)).toBe(1);
    expect(reopened.integrityCheck().ok).toBe(true);
  });
});

describe("admission against the page, WAL and total budgets", () => {
  const tiny = {
    maxDbBytes: 1 * MIB,
    highWatermarkBytes: 768 * KIB,
    lowWatermarkBytes: 512 * KIB,
    walAllowanceBytes: 4 * MIB,
    reserveBytes: 1 * MIB,
    vacuumBatchPages: 16,
  };

  it("refuses a batch that cannot fit under the page limit, before writing", () => {
    const dir = makeStoreDir();
    const store = track(openStore(dir, { limits: tiny }));
    const src = source();
    const before = statSync(join(dir, "session-search.sqlite3")).size;
    const result = store.commitBatch(
      batchOf(src, bigRecords("huge", 200, 16 * KIB, MS)),
      { expected: null, next: "c1" },
    );
    expect(result.committed).toBe(false);
    expect(result.refusal?.code).toBe("db_capacity");
    expect(result.estimatedDirtyPages).toBe(0);
    expect(store.getCursor(src)).toBeNull();
    expect(committedRows(dir)).toBe(0);
    expect(statSync(join(dir, "session-search.sqlite3")).size).toBe(before);
  });

  it("refuses when the WAL allowance would be exceeded", () => {
    const dir = makeStoreDir();
    const store = track(
      openStore(dir, {
        limits: { ...tiny, maxDbBytes: 64 * MIB, highWatermarkBytes: 48 * MIB, lowWatermarkBytes: 32 * MIB, walAllowanceBytes: 64 * KIB },
      }),
    );
    const result = store.commitBatch(
      batchOf(source(), bigRecords("wal", 50, 8 * KIB, MS)),
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("wal_reserve");
    expect(committedRows(dir)).toBe(0);
  });

  it("refuses under total-budget pressure", () => {
    const dir = makeStoreDir();
    const store = track(
      openStore(dir, {
        limits: { ...tiny, maxDbBytes: 64 * MIB, highWatermarkBytes: 48 * MIB, lowWatermarkBytes: 32 * MIB, walAllowanceBytes: 8 * MIB, totalPressureRatio: 0.0001 },
      }),
    );
    const result = store.commitBatch(
      batchOf(source(), bigRecords("tot", 5, KIB, MS)),
      { expected: null, next: "c1" },
    );
    expect(result.refusal?.code).toBe("total_budget");
    expect(committedRows(dir)).toBe(0);
  });
});

describe("incremental vacuum", () => {
  it("shrinks the file in bounded batches down to the low watermark", () => {
    const dir = makeStoreDir();
    const store = track(
      openStore(dir, {
        limits: {
          maxDbBytes: 64 * MIB,
          highWatermarkBytes: 2 * MIB,
          lowWatermarkBytes: 1 * MIB,
          vacuumBatchPages: 32,
        },
      }),
    );
    const src = source("bulk");
    for (let batch = 0; batch < 8; batch += 1) {
      const result = store.commitBatch(
        batchOf(src, bigRecords(`b${batch}`, 100, 4 * KIB, MS + batch * 100)),
        nextCursor(store, src, `c${batch}`),
      );
      expect(result.committed).toBe(true);
    }
    const grown = store.capacity();
    expect(grown.allocatedBytes).toBeGreaterThan(2 * MIB);
    const stuck = store.reclaim();
    expect(stuck.skipped).toBe(false);
    expect(stuck.ok).toBe(false);
    expect(stuck.reason).toBe("no_free_pages");
    expect(store.suspended?.code).toBe("db_capacity");
    store.resume();

    store.removeSource("bulk", { chunkRows: 50 });
    store.checkpoint("TRUNCATE");
    const freed = store.capacity();
    expect(freed.freelistCount).toBeGreaterThan(0);
    const fileBefore = statSync(join(dir, "session-search.sqlite3")).size;

    const result = store.reclaim();
    expect(result.skipped).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.batches).toBeGreaterThan(1);
    expect(result.reachedLowWatermark).toBe(true);
    expect(result.allocatedAfter).toBeLessThanOrEqual(1 * MIB);
    const fileAfter = statSync(join(dir, "session-search.sqlite3")).size;
    expect(fileAfter).toBeLessThan(fileBefore);
    expect(result.fileBytesAfter).toBe(fileAfter);
    expect(store.integrityCheck().ok).toBe(true);
  });

  it("skips reclamation below the high watermark", () => {
    const dir = makeStoreDir();
    const store = track(openStore(dir));
    const result = store.reclaim();
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(store.suspended).toBeNull();
  });

  it("reports a forced reclaim that has nothing to free without suspending", () => {
    const dir = makeStoreDir();
    const store = track(
      openStore(dir, {
        limits: {
          maxDbBytes: 64 * MIB,
          highWatermarkBytes: 2 * MIB,
          lowWatermarkBytes: 64 * KIB,
        },
      }),
    );
    const result = store.reclaim({ force: true });
    expect(result.ok).toBe(false);
    expect(store.suspended).toBeNull();
  });
});
