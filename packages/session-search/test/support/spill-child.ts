import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { openReadonlyConnection, openStore } from "../../src/storage.js";
import { batchOf, message, nextCursor, source } from "./store-helpers.js";

const MS = 1_700_000_000_000;
const dir = process.argv[2];
if (dir === undefined) throw new Error("store directory argument required");

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
  if (!result.committed) throw new Error("fixture commit refused");
}
const reader = openReadonlyConnection(dir);
const iterator = reader
  .prepare("SELECT text FROM content ORDER BY text DESC")
  .iterate();
iterator.next();
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
reader.close();
store.close();
process.stdout.write(
  JSON.stringify({ spilled, tmpDir: join(dir, "tmp") }) + "\n",
);
