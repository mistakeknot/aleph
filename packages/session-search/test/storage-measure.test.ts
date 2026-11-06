import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  estimateDirtyPages,
  openReadonlyConnection,
  openStore,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  fixtureText,
  makeStoreDir,
  message,
  nextCursor,
  seededRandom,
  shuffled,
  source,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;
const DAY = 86_400_000;
const PAGE_SIZE = 4096;
const WAL_FRAME_BYTES = PAGE_SIZE + 24;
const WAL_HEADER_BYTES = 32;
const open: SessionSearchStore[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  cleanupStoreDirs();
});

interface BatchMeasure {
  records: number;
  textBytes: number;
  frames: number;
  estimate: number;
}

describe("shuffled-ingest measurement", () => {
  it("keeps measured dirty pages under the estimate and reports fill factor", () => {
    const dir = makeStoreDir();
    const store = openStore(dir, {
      limits: { walAutoCheckpointPages: 1_000_000 },
    });
    open.push(store);
    const src = source("measure");
    const random = seededRandom(7);
    const total = 1200;
    const perBatch = 50;
    const stamps = shuffled(
      Array.from({ length: total }, (_, index) => MS + index * (DAY / 40)),
      11,
    );
    const measures: BatchMeasure[] = [];

    for (let start = 0; start < total; start += perBatch) {
      const records = stamps.slice(start, start + perBatch).map((at, index) => {
        const words = 20 + Math.floor(random() * 260);
        return message(
          `m-${start + index}`,
          fixtureText(random, words),
          at,
        );
      });
      store.checkpoint("TRUNCATE");
      const result = store.commitBatch(
        batchOf(src, records),
        nextCursor(store, src, `c${start}`),
      );
      expect(result.committed).toBe(true);
      const wal = store.physicalBytes().wal;
      const textBytes = records.reduce(
        (sum, record) => sum + Buffer.byteLength(record.text, "utf8"),
        0,
      );
      measures.push({
        records: records.length,
        textBytes,
        frames: Math.max(0, wal - WAL_HEADER_BYTES) / WAL_FRAME_BYTES,
        estimate: estimateDirtyPages(
          records.map((record) => ({
            textBytes: Buffer.byteLength(record.text, "utf8"),
            touches: 0,
          })),
          PAGE_SIZE,
        ),
      });
    }

    store.checkpoint("TRUNCATE");
    const db = openReadonlyConnection(dir);
    let fill: Record<string, number> = {};
    try {
      const rows = db
        .prepare(
          "SELECT name, sum(pgsize - unused) * 1.0 / sum(pgsize) AS fill, count(*) AS pages FROM dbstat WHERE aggregate = 0 GROUP BY name",
        )
        .all() as { name: string; fill: number; pages: number }[];
      fill = Object.fromEntries(rows.map((row) => [row.name, row.fill]));
      const content = rows.find((row) => row.name === "content");
      expect(content).toBeDefined();
    } finally {
      db.close();
    }

    const peakFrames = Math.max(...measures.map((entry) => entry.frames));
    const worstRatio = Math.max(
      ...measures.map((entry) => entry.frames / entry.estimate),
    );
    const report = {
      records: total,
      batches: measures.length,
      pageSize: PAGE_SIZE,
      peakDirtyFrames: peakFrames,
      peakEstimate: Math.max(...measures.map((entry) => entry.estimate)),
      worstFramesOverEstimate: worstRatio,
      fillFactor: fill,
    };
    const out = process.env.SESSION_SEARCH_MEASURE_OUT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`MEASURE ${JSON.stringify(report)}\n`);

    for (const entry of measures) {
      expect(entry.frames).toBeGreaterThan(0);
      expect(entry.frames).toBeLessThanOrEqual(entry.estimate);
    }
    expect(fill["content"]).toBeGreaterThan(0.3);
    expect(store.integrityCheck().ok).toBe(true);
  });
});
