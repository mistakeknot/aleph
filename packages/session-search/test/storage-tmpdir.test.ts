import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { childEnvironment, openStore, StoreError } from "../src/storage.js";
import { cleanupStoreDirs, makeStoreDir } from "./support/store-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

interface ChildOutput {
  spilled: string[];
  tmpDir: string;
  secondStoreError: string | null;
}

afterEach(() => {
  cleanupStoreDirs();
});

function runChild(
  env: NodeJS.ProcessEnv,
  dir: string,
  otherDir?: string,
): ChildOutput {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(here, "support", "spill-child.ts"),
      dir,
      ...(otherDir === undefined ? [] : [otherDir]),
    ],
    { encoding: "utf8", env, cwd: join(here, "..") },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}");
}

describe("temporary-file placement", () => {
  it("builds a child environment that points SQLite at the store's private tmp directory", () => {
    const dir = makeStoreDir();
    const env = childEnvironment(dir, { PATH: "/usr/bin" });
    expect(env["SQLITE_TMPDIR"]).toBe(join(dir, "tmp"));
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("refuses to open when the process was not started with the store's tmp directory", () => {
    const dir = makeStoreDir();
    const saved = process.env["SQLITE_TMPDIR"];
    try {
      delete process.env["SQLITE_TMPDIR"];
      expect(() => openStore(dir)).toThrow(StoreError);
      process.env["SQLITE_TMPDIR"] = makeStoreDir();
      try {
        openStore(dir);
        expect.unreachable("open must refuse a foreign SQLITE_TMPDIR");
      } catch (error) {
        expect((error as StoreError).code).toBe("temp_dir_unbound");
      }
    } finally {
      if (saved === undefined) delete process.env["SQLITE_TMPDIR"];
      else process.env["SQLITE_TMPDIR"] = saved;
    }
  });

  it.skipIf(process.platform !== "linux")(
    "spills into the private tmp directory even after SQLite was initialised, and refuses a second store with a different directory",
    () => {
      const dir = makeStoreDir();
      const other = makeStoreDir();
      const out = runChild(childEnvironment(dir), dir, other);
      expect(out.spilled.length).toBeGreaterThan(0);
      expect(
        out.spilled.every((link) => link.startsWith(`${out.tmpDir}/`)),
      ).toBe(true);
      expect(out.secondStoreError).toBe("temp_dir_unbound");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "refuses a store opened in a process that was started without the setting",
    () => {
      const dir = makeStoreDir();
      const env = { ...process.env };
      delete env["SQLITE_TMPDIR"];
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", join(here, "support", "spill-child.ts"), dir],
        { encoding: "utf8", env, cwd: join(here, "..") },
      );
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain("SQLITE_TMPDIR");
    },
  );
});
