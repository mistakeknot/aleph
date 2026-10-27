import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  migratingInfoPath,
  readActiveMigration,
  readHolderInfo,
} from "../src/migration-info.js";

const tempDirs: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-migration-info-"));
  tempDirs.push(directory);
  return join(directory, "bb.db");
}

function writeInfo(path: string, pid: number, phase = "migrating"): void {
  writeFileSync(
    migratingInfoPath(path),
    JSON.stringify({
      pid,
      token: "t",
      databaseBytes: 1,
      expectedMs: 2,
      phase,
      updatedAt: 3,
    }),
  );
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""]);
  if (result.pid === undefined) throw new Error("spawn failed");
  return result.pid;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration info", () => {
  it("reads nothing when there is no info file", () => {
    const path = databasePath();
    expect(readHolderInfo(path)).toBeNull();
    expect(readActiveMigration(path)).toBeNull();
  });

  it("reads a valid info file", () => {
    const path = databasePath();
    writeInfo(path, process.pid);
    expect(readHolderInfo(path)).toEqual({
      pid: process.pid,
      token: "t",
      databaseBytes: 1,
      expectedMs: 2,
      phase: "migrating",
      updatedAt: 3,
    });
  });

  it("ignores a malformed info file", () => {
    const path = databasePath();
    writeFileSync(migratingInfoPath(path), "{not json");
    expect(readHolderInfo(path)).toBeNull();
    writeFileSync(migratingInfoPath(path), JSON.stringify({ pid: "x" }));
    expect(readHolderInfo(path)).toBeNull();
  });

  it("reports a migration only while the holder process is alive", () => {
    const path = databasePath();
    writeInfo(path, process.pid);
    expect(readActiveMigration(path)?.pid).toBe(process.pid);
    writeInfo(path, deadPid());
    expect(readHolderInfo(path)).not.toBeNull();
    expect(readActiveMigration(path)).toBeNull();
  });

  it("detects live and dead processes", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });
});
