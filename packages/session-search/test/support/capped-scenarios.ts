import { rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  INITIAL_MIGRATION,
  type StoreMigration,
} from "../../src/migrations.js";
import {
  openReadonlyConnection,
  openStore,
  resetStore,
  type StoreLimits,
} from "../../src/storage.js";
import { batchOf, message, nextCursor, source } from "./store-helpers.js";

const MS = 1_700_000_000_000;
const KIB = 1024;
const MIB = 1024 * KIB;

const mount = process.argv[2];
const name = process.argv[3];
if (mount === undefined || name === undefined) {
  throw new Error("usage: capped-scenarios <mount> <scenario> [options-json]");
}
const options = JSON.parse(process.argv[4] ?? "{}") as Record<string, unknown>;
const dir = join(mount, "store");

function limitsFor(volumeBytes: number): Partial<StoreLimits> {
  const maxDbBytes = Math.floor((volumeBytes * 8) / 4096) * 4096;
  return {
    maxDbBytes,
    highWatermarkBytes: maxDbBytes - 4096 * 2,
    lowWatermarkBytes: Math.floor(maxDbBytes / 2 / 4096) * 4096,
    walAllowanceBytes: 4 * MIB,
    reserveBytes: 256 * KIB,
    vacuumBatchPages: 64,
  };
}

function freeBytes(): number {
  const stats = statfsSync(mount!);
  return Number(stats.bavail) * Number(stats.bsize);
}

function rowCount(): number {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db.prepare("SELECT count(*) AS n FROM content").get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function records(prefix: string, count: number, bytes: number, at: number) {
  const filler = "payload ".repeat(Math.ceil(bytes / 8));
  return Array.from({ length: count }, (_, index) =>
    message(
      `${prefix}-${index}`,
      `${prefix}${index} ${filler}`.slice(0, bytes),
      at + index,
    ),
  );
}

function enospc(volumeBytes: number): unknown {
  const store = openStore(dir, { limits: limitsFor(volumeBytes) });
  const src = source("enospc");
  const ballast = join(mount!, "ballast");
  writeFileSync(ballast, Buffer.alloc(512 * KIB, 1));
  let batches = 0;
  let lastCursor: string | null = null;
  let refusal: { code: string; message: string } | null = null;
  let refusedCursor: string | null = null;
  for (let batch = 0; batch < 400 && refusal === null; batch += 1) {
    const cursor = `c${batch}`;
    const result = store.commitBatch(
      batchOf(src, records(`fill${batch}`, 8, 16 * KIB, MS + batch * 8)),
      nextCursor(store, src, cursor),
    );
    if (result.committed) {
      batches += 1;
      lastCursor = cursor;
    } else {
      refusal = result.refusal;
      refusedCursor = result.cursor;
    }
  }
  const rowsAfterRefusal = rowCount();
  const cursorAfterRefusal = store.getCursor(src);
  const integrity = store.integrityCheck();
  const suspended = store.suspended?.code ?? null;
  const refusedAgain = store.commitBatch(
    batchOf(src, [message("blocked", "blocked while suspended", MS + 100000)]),
    nextCursor(store, src, "blocked"),
  );

  rmSync(ballast);
  store.resume();
  const resumed = store.commitBatch(
    batchOf(src, [
      message("after", "committed after space returned", MS + 100001),
    ]),
    nextCursor(store, src, "after"),
  );
  const out = {
    batches,
    lastCursor,
    refusal,
    refusedCursor,
    cursorAfterRefusal,
    rowsAfterRefusal,
    expectedRows: batches * 8,
    integrity,
    suspended,
    refusedAgain: refusedAgain.refusal?.code ?? null,
    resumedCommitted: resumed.committed,
    resumedCursor: store.getCursor(src),
    rowsAfterResume: rowCount(),
    integrityAfterResume: store.integrityCheck(),
  };
  store.close();
  return out;
}

function populate(
  store: ReturnType<typeof openStore>,
  key: string,
  batches: number,
) {
  const src = source(key);
  for (let batch = 0; batch < batches; batch += 1) {
    const result = store.commitBatch(
      batchOf(src, records(`${key}${batch}`, 8, 16 * KIB, MS + batch * 8)),
      nextCursor(store, src, `c${batch}`),
    );
    if (!result.committed)
      throw new Error(`populate refused: ${result.refusal?.code}`);
  }
}

function vacuum(volumeBytes: number): unknown {
  const limits = limitsFor(volumeBytes);
  const store = openStore(dir, {
    limits: {
      ...limits,
      highWatermarkBytes: 1 * MIB,
      lowWatermarkBytes: 512 * KIB,
    },
  });
  populate(store, "bulk", 12);
  store.checkpoint("TRUNCATE");
  const freeBeforeDelete = freeBytes();
  store.removeSource("bulk", { chunkRows: 40 });
  store.checkpoint("TRUNCATE");
  const result = store.reclaim();
  const freeAfter = freeBytes();
  const out = {
    freeBeforeDelete,
    freeAfter,
    reclaimed: result.ok,
    reachedLow: result.reachedLowWatermark,
    batches: result.batches,
    integrity: store.integrityCheck(),
  };
  store.close();
  return out;
}

function schemaBump(volumeBytes: number): unknown {
  const limits = limitsFor(volumeBytes);
  const store = openStore(dir, { limits });
  populate(store, "old", 12);
  store.close();
  const bump: StoreMigration = {
    version: 2,
    name: "layout-change",
    stagingPages: 0,
    requiresReset: true,
    up(db) {
      db.exec("CREATE TABLE layout_marker (id INTEGER PRIMARY KEY)");
    },
  };
  const freeBefore = freeBytes();
  const { store: fresh, diagnostics } = resetStore(dir, {
    confirm: true,
    migrations: [INITIAL_MIGRATION, bump],
    limits,
  });
  const out = {
    freeBefore,
    freeAfter: freeBytes(),
    previousVersion: diagnostics.previousVersion,
    previousContentCount: diagnostics.previousContentCount,
    version: fresh.schemaVersion,
    rowsAfter: rowCount(),
    integrity: fresh.integrityCheck(),
  };
  fresh.close();
  return out;
}

const volumeBytes = Number(options.volumeBytes ?? 8 * MIB);
const scenarios: Record<string, (bytes: number) => unknown> = {
  enospc,
  vacuum,
  schemaBump,
};
const scenario = scenarios[name];
if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
process.stdout.write(JSON.stringify(scenario(volumeBytes)) + "\n");
