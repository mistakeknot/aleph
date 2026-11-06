import { afterEach, describe, expect, it } from "vitest";

import { FTS_AUTOMERGE, FTS_CRISISMERGE } from "../src/migrations.js";
import {
  EMPTY_FTS_STRUCTURE,
  estimateBatchFlushes,
  mergeMayRun,
  parseFtsStructure,
  readFtsStructure,
} from "../src/fts-structure.js";
import {
  attributeMemoryFailure,
  parseMemoryPressureState,
} from "../src/memory-pressure.js";
import {
  openReadonlyConnection,
  type OpenStoreOptions,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  fakeMemory,
  makeStoreDir,
  message,
  seededRandom,
  fixtureText,
  source,
  openTestStore,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;
const THRESHOLDS = { automerge: FTS_AUTOMERGE, crisismerge: FTS_CRISISMERGE };
const open: SessionSearchStore[] = [];

function track(dir: string, options?: OpenStoreOptions): SessionSearchStore {
  const store = openTestStore(dir, options);
  open.push(store);
  return store;
}

function closeAll(): void {
  while (open.length > 0) open.pop()!.close();
}

afterEach(() => {
  closeAll();
  cleanupStoreDirs();
});

function structureOf(dir: string) {
  const db = openReadonlyConnection(dir);
  try {
    return readFtsStructure(db);
  } finally {
    db.close();
  }
}

describe("FTS structure snapshot", () => {
  it("reports an empty fresh store as unable to merge", () => {
    const dir = makeStoreDir();
    track(dir);
    const structure = structureOf(dir);
    expect(structure.totalSegments).toBe(0);
    expect(mergeMayRun(structure, THRESHOLDS)).toBe(false);
    expect(mergeMayRun(EMPTY_FTS_STRUCTURE, THRESHOLDS)).toBe(false);
  });

  it("rejects truncated or absurd records", () => {
    expect(() => parseFtsStructure(Uint8Array.from([0, 0]))).toThrow();
    expect(() =>
      parseFtsStructure(Uint8Array.from([0, 0, 0, 0, 0x7f, 1, 1])),
    ).toThrow();
  });

  it("treats a level at the automerge reach, a merge in progress or a crisis level as possible", () => {
    expect(
      mergeMayRun(
        { totalSegments: 3, levels: [{ mergeInProgress: 0, segments: 3 }] },
        THRESHOLDS,
      ),
    ).toBe(true);
    expect(
      mergeMayRun(
        { totalSegments: 1, levels: [{ mergeInProgress: 1, segments: 1 }] },
        THRESHOLDS,
      ),
    ).toBe(true);
    expect(
      mergeMayRun(
        { totalSegments: 1, levels: [{ mergeInProgress: 0, segments: 1 }] },
        THRESHOLDS,
      ),
    ).toBe(false);
  });

  it("flags a merge as possible beforehand whenever the segment count drops", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const random = seededRandom(7);
    let cursor: string | null = null;
    let observedMerge = false;
    for (let batch = 0; batch < 60; batch += 1) {
      const records = Array.from({ length: 6 }, (_, index) =>
        message(
          `b${batch}-${index}`,
          fixtureText(random, 40 + Math.floor(random() * 80)),
          MS + batch * 10 + index,
        ),
      );
      const prior = structureOf(dir);
      const result = store.commitBatch(batchOf(source(), records), {
        expected: cursor,
        next: `c${batch}`,
      });
      expect(result.committed).toBe(true);
      cursor = `c${batch}`;
      const after = structureOf(dir);
      const expected = mergeMayRun(prior, THRESHOLDS, records.length);
      expect(result.mergePossible).toBe(expected);
      if (after.totalSegments < prior.totalSegments + records.length) {
        observedMerge = true;
        expect(expected).toBe(true);
      }
    }
    expect(observedMerge).toBe(true);
  });

  it("counts a descending time-keyed batch as several flushes against an empty store", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const random = seededRandom(11);
    const records = Array.from({ length: 20 }, (_, index) =>
      message(
        `desc-${index}`,
        fixtureText(random, 30),
        MS + (20 - index) * 1000,
      ),
    );
    const prior = structureOf(dir);
    expect(prior.totalSegments).toBe(0);
    const result = store.commitBatch(batchOf(source(), records), {
      expected: null,
      next: "c0",
    });
    expect(result.committed).toBe(true);
    const after = structureOf(dir);
    expect(after.totalSegments).not.toBe(prior.totalSegments + 1);
    expect(after.totalSegments).toBeLessThan(20);
    expect(result.mergePossible).toBe(true);
  });

  it("counts hash-table overflow from a large ascending batch as several flushes", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const random = seededRandom(13);
    const unique = (tokens: number): string => {
      const out: string[] = [];
      for (let index = 0; index < tokens; index += 1) {
        out.push(random().toString(36).slice(2, 10));
      }
      return out.join(" ");
    };
    const records = Array.from({ length: 4 }, (_, index) =>
      message(`large-${index}`, unique(100_000), MS + index),
    );
    const prior = structureOf(dir);
    const result = store.commitBatch(batchOf(source(), records), {
      expected: null,
      next: "c0",
    });
    expect(result.committed).toBe(true);
    const after = structureOf(dir);
    expect(after.totalSegments).not.toBe(prior.totalSegments + 1);
    expect(result.mergePossible).toBe(true);
  });

  it("never reports a merge as impossible when the segment count moved by other than one flush", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const random = seededRandom(17);
    let cursor: string | null = null;
    for (let batch = 0; batch < 30; batch += 1) {
      const descending = batch % 3 === 0;
      const records = Array.from({ length: 5 }, (_, index) =>
        message(
          `mix${batch}-${index}`,
          fixtureText(random, 30),
          MS + batch * 100 + (descending ? 5 - index : index),
        ),
      );
      const prior = structureOf(dir);
      const result = store.commitBatch(batchOf(source(), records), {
        expected: cursor,
        next: `c${batch}`,
      });
      expect(result.committed).toBe(true);
      cursor = `c${batch}`;
      const after = structureOf(dir);
      if (after.totalSegments !== prior.totalSegments + 1) {
        expect(result.mergePossible).toBe(true);
      }
    }
  });
});

describe("batch flush estimate", () => {
  it("counts one flush for every inserted record", () => {
    expect(
      estimateBatchFlushes([
        { replaces: false, textBytes: 100 },
        { replaces: false, textBytes: 100 },
        { replaces: false, textBytes: 100 },
      ]),
    ).toBe(3);
  });

  it("counts two flushes for a replaced record and at least one for an empty batch", () => {
    expect(estimateBatchFlushes([{ replaces: true, textBytes: 10 }])).toBe(2);
    expect(estimateBatchFlushes([])).toBe(1);
  });

  it("adds flushes for text that can overflow the hash table", () => {
    expect(
      estimateBatchFlushes([{ replaces: false, textBytes: 1024 * 1024 }]),
    ).toBe(5);
  });

  it("treats an empty store as able to merge once enough flushes are expected", () => {
    expect(mergeMayRun(EMPTY_FTS_STRUCTURE, THRESHOLDS, 3)).toBe(false);
    expect(mergeMayRun(EMPTY_FTS_STRUCTURE, THRESHOLDS, FTS_AUTOMERGE)).toBe(
      true,
    );
  });
});

describe("memory-pressure attribution", () => {
  const failure = (mergePossible: boolean, atMs = 1) => ({
    sourceKey: "s",
    generation: 1,
    mergePossible,
    atMs,
  });

  it("charges the store when a merge could have run", () => {
    expect(
      attributeMemoryFailure({
        failures: [failure(true), failure(false)],
        interveningSuccessesFromOtherSources: 3,
      }).scope,
    ).toBe("store");
  });

  it("charges the store for a lone failure or without intervening successes", () => {
    expect(
      attributeMemoryFailure({
        failures: [failure(false)],
        interveningSuccessesFromOtherSources: 5,
      }).scope,
    ).toBe("store");
    expect(
      attributeMemoryFailure({
        failures: [failure(false), failure(false, 2)],
        interveningSuccessesFromOtherSources: 0,
      }).scope,
    ).toBe("store");
  });

  it("charges the source only with repeated merge-free failures and other sources committing", () => {
    expect(
      attributeMemoryFailure({
        failures: [failure(false), failure(false, 2)],
        interveningSuccessesFromOtherSources: 1,
      }).scope,
    ).toBe("source");
  });

  it("rejects an unknown stored status", () => {
    expect(() => parseMemoryPressureState('{"status":"weird"}')).toThrow();
  });
});

describe("persisted store-level suspension and controlled retry", () => {
  function setup(dir: string, memory = fakeMemory()) {
    let now = 5_000;
    const store = track(dir, {
      memory: { provider: memory.provider },
      now: () => now,
    });
    return { store, memory, tick: (ms: number) => (now += ms) };
  }

  it("suspends the store after an allocation failure and survives a restart", () => {
    const dir = makeStoreDir();
    let failNext = true;
    const memory = fakeMemory();
    const store = track(dir, {
      memory: { provider: memory.provider },
      testHooks: {
        afterApply() {
          if (!failNext) return;
          failNext = false;
          const error = new Error("out of memory") as Error & { code: string };
          error.code = "SQLITE_NOMEM";
          throw error;
        },
      },
    });
    const first = store.commitBatch(
      batchOf(source(), [message("a", "alpha text", MS)]),
      { expected: null, next: "c1" },
    );
    expect(first.refusal?.code).toBe("out_of_memory");
    expect(store.getCursor(source())).toBeNull();
    expect(store.suspended?.code).toBe("memory_pressure");
    expect(store.memoryPressure().status).toBe("suspended");

    const second = store.commitBatch(
      batchOf(source("other"), [message("b", "beta text", MS)]),
      { expected: null, next: "c1" },
    );
    expect(second.refusal?.code).toBe("memory_pressure");
    expect(memory.outstanding()).toBe(0);

    closeAll();
    const reopened = track(dir, { memory: { provider: memory.provider } });
    expect(reopened.memoryPressure().status).toBe("suspended");
    expect(reopened.memoryPressure().totalFailures).toBe(1);
    const third = reopened.commitBatch(
      batchOf(source("other"), [message("b", "beta text", MS)]),
      { expected: null, next: "c1" },
    );
    expect(third.refusal?.code).toBe("memory_pressure");
  });

  it("allows one controlled retry after a mitigation and clears on a clean commit", () => {
    const dir = makeStoreDir();
    const { store } = setup(dir);
    store.recordMemoryPressure({ source: source(), mergePossible: true });
    expect(store.memoryPressure().status).toBe("suspended");

    expect(store.beginControlledRetry({ mitigation: "  " })).toMatchObject({
      ok: false,
    });
    const armed = store.beginControlledRetry({ mitigation: "freed cache" });
    expect(armed).toMatchObject({ ok: true });
    expect(store.memoryPressure()).toMatchObject({
      status: "retry_armed",
      retriesUsed: 1,
      mitigation: "freed cache",
    });

    const retry = store.commitBatch(
      batchOf(source(), [message("a", "alpha text", MS)]),
      { expected: null, next: "c1" },
    );
    expect(retry.committed).toBe(true);
    expect(store.memoryPressure()).toMatchObject({
      status: "clear",
      clears: 1,
      retriesUsed: 0,
      mitigation: null,
      totalFailures: 1,
    });
    expect(store.suspended).toBeNull();
  });

  it("keeps the store suspended when the single retry fails and refuses a second retry", () => {
    const dir = makeStoreDir();
    const { store } = setup(dir);
    store.recordMemoryPressure({ source: source(), mergePossible: true });
    expect(store.beginControlledRetry({ mitigation: "m1" })).toMatchObject({
      ok: true,
    });
    store.recordMemoryPressure({ source: source(), mergePossible: true });
    expect(store.memoryPressure()).toMatchObject({
      status: "suspended",
      retriesUsed: 1,
      totalFailures: 2,
    });
    const second = store.beginControlledRetry({ mitigation: "m2" });
    expect(second.ok).toBe(false);
    closeAll();
    const reopened = track(dir);
    expect(reopened.memoryPressure()).toMatchObject({
      status: "suspended",
      retriesUsed: 1,
    });
  });

  it("requires fresh headroom and a provider to begin the retry", () => {
    const dir = makeStoreDir();
    const { store, memory } = setup(dir);
    store.recordMemoryPressure({ source: source(), mergePossible: true });
    memory.setSample(null);
    expect(store.beginControlledRetry({ mitigation: "m" })).toMatchObject({
      ok: false,
    });
    expect(store.memoryPressure().status).toBe("suspended");
    expect(memory.outstanding()).toBe(0);

    const bare = makeStoreDir();
    const noProvider = track(bare);
    noProvider.recordMemoryPressure({ source: source(), mergePossible: true });
    expect(noProvider.beginControlledRetry({ mitigation: "m" })).toMatchObject({
      ok: false,
    });
  });

  it("does not suspend the store for repeated merge-free failures of one source when others commit", () => {
    const dir = makeStoreDir();
    const { store, tick } = setup(dir);
    const bad = source("bad");
    const good = source("good");
    store.recordMemoryPressure({
      source: bad,
      mergePossible: false,
      observedAtMs: tick(0),
    });
    expect(store.memoryPressure().status).toBe("suspended");
    store.beginControlledRetry({ mitigation: "m" });
    store.commitBatch(batchOf(good, [message("g1", "good text", MS)]), {
      expected: null,
      next: "g1",
    });
    expect(store.memoryPressure().status).toBe("clear");
    tick(100);
    store.commitBatch(batchOf(good, [message("g2", "more good text", MS)]), {
      expected: "g1",
      next: "g2",
    });
    store.recordMemoryPressure({
      source: bad,
      mergePossible: false,
      observedAtMs: tick(100),
    });
    const state = store.memoryPressure();
    expect(state.recent.filter((f) => f.sourceKey === "bad")).toHaveLength(2);
    expect(state.status).toBe("clear");
  });
});

describe("connection settings", () => {
  it("applies the tuned cache, mmap and temp settings on read and write connections", () => {
    const dir = makeStoreDir();
    const store = track(dir);
    expect(store.settings()).toMatchObject({
      cacheSize: -8192,
      mmapSize: 0,
      tempStore: 1,
    });
    const reader = openReadonlyConnection(dir);
    try {
      expect(reader.pragma("mmap_size", { simple: true })).toBe(0);
      expect(reader.pragma("cache_size", { simple: true })).toBe(-8192);
    } finally {
      reader.close();
    }
  });

  it("persists the automerge and crisismerge settings in the schema seed", () => {
    const dir = makeStoreDir();
    track(dir);
    const db = openReadonlyConnection(dir);
    try {
      const meta = db
        .prepare("SELECT value FROM meta WHERE key = 'fts_automerge'")
        .get() as { value: string };
      expect(meta.value).toBe(String(FTS_AUTOMERGE));
      const config = db
        .prepare("SELECT k, v FROM content_fts_config")
        .all() as Array<{ k: string; v: unknown }>;
      const byKey = Object.fromEntries(config.map((row) => [row.k, row.v]));
      expect(byKey["automerge"]).toBe(FTS_AUTOMERGE);
      expect(byKey["crisismerge"]).toBe(FTS_CRISISMERGE);
    } finally {
      db.close();
    }
  });
});
