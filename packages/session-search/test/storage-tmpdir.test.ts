import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { cleanupStoreDirs, makeStoreDir } from "./support/store-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanupStoreDirs();
});

it.skipIf(process.platform !== "linux")(
  "spills temporary sort files into the store's private tmp directory in a fresh process",
  () => {
    const dir = makeStoreDir();
    const env = { ...process.env };
    delete env["SQLITE_TMPDIR"];
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "support", "spill-child.ts"), dir],
      { encoding: "utf8", env, cwd: join(here, "..") },
    );
    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}") as {
      spilled: string[];
      tmpDir: string;
    };
    expect(out.spilled.length).toBeGreaterThan(0);
    expect(out.spilled.every((link) => link.startsWith(`${out.tmpDir}/`))).toBe(
      true,
    );
  },
);
