import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openReadonlyConnection, openStore } from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  makeStoreDir,
  message,
  nextCursor,
  source,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;

afterEach(() => {
  cleanupStoreDirs();
});

it.skipIf(process.platform !== "linux")(
  "spills temporary sort files into the store's private tmp directory",
  () => {
    const dir = makeStoreDir();
    const store = openStore(dir);
    const filler = "lorem ipsum dolor sit amet ".repeat(160);
    for (let batch = 0; batch < 6; batch += 1) {
      const records = Array.from({ length: 400 }, (_, index) =>
        message(
          `t${batch}-${index}`,
          `${filler}${batch}-${index}`,
          MS + batch * 400 + index,
        ),
      );
      const result = store.commitBatch(
        batchOf(source("spill"), records),
        nextCursor(store, source("spill"), `c${batch}`),
      );
      expect(result.committed).toBe(true);
    }
    const reader = openReadonlyConnection(dir);
    try {
      const iterator = reader
        .prepare("SELECT text FROM content ORDER BY text DESC")
        .iterate();
      iterator.next();
      const tmpDir = join(dir, "tmp");
      const spilled = readdirSync("/proc/self/fd")
        .map((fd) => {
          try {
            return readlinkSync(join("/proc/self/fd", fd));
          } catch {
            return "";
          }
        })
        .filter((link) => link.includes("etilqs_"));
      iterator.return?.();
      expect(spilled.length).toBeGreaterThan(0);
      expect(spilled.every((link) => link.startsWith(`${tmpDir}/`))).toBe(
        true,
      );
    } finally {
      reader.close();
      store.close();
    }
  },
);
