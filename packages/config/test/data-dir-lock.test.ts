import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLockTimeoutError } from "../src/file-lock.js";
import {
  acquireDataDirLock,
  readDataDirLockHolders,
} from "../src/data-dir-lock.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "aleph-lock-"));
});

afterEach(() => {
  rmSync(dataDir, { force: true, recursive: true });
});

const holder = { bundlePath: "/Applications/Aleph.app" };

describe("data-dir lock (plan 7.4)", () => {
  it("lets shared holders coexist and records each holder's pid and bundle", async () => {
    const first = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "shared",
      timeoutMs: 200,
    });
    const second = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "shared",
      timeoutMs: 200,
    });
    const holders = readDataDirLockHolders(dataDir);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toMatchObject({
      bundlePath: holder.bundlePath,
      mode: "shared",
      pid: process.pid,
    });
    await first.release();
    await second.release();
    expect(readDataDirLockHolders(dataDir)).toEqual([]);
  });

  it("blocks an exclusive request while any shared holder remains", async () => {
    const shared = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "shared",
      timeoutMs: 200,
    });
    await expect(
      acquireDataDirLock({
        dataDir,
        holder,
        mode: "exclusive",
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(readDataDirLockHolders(dataDir)).toHaveLength(1);
    await shared.release();
    const exclusive = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "exclusive",
      timeoutMs: 200,
    });
    await exclusive.release();
  });

  it("blocks shared and exclusive requests while an exclusive holder is present", async () => {
    const exclusive = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "exclusive",
      timeoutMs: 200,
    });
    for (const mode of ["shared", "exclusive"] as const) {
      await expect(
        acquireDataDirLock({ dataDir, holder, mode, timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    }
    await exclusive.release();
    const shared = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "shared",
      timeoutMs: 200,
    });
    await shared.release();
  });

  it("ignores holder records whose process is gone", async () => {
    const shared = await acquireDataDirLock({
      dataDir,
      holder,
      mode: "shared",
      timeoutMs: 200,
    });
    const [file] = readdirSync(join(dataDir, ".lock-holders"));
    expect(file).toBeDefined();
    expect(
      readDataDirLockHolders(dataDir, { isProcessRunning: () => false }),
    ).toEqual([]);
    await shared.release();
  });
});
