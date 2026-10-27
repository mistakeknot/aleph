import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  processIdentity,
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

function writeInfo(
  path: string,
  pid: number,
  extra: Record<string, unknown> = {},
  phase = "migrating",
): void {
  writeFileSync(
    migratingInfoPath(path),
    JSON.stringify({
      pid,
      token: "t",
      databaseBytes: 1,
      expectedMs: 2,
      phase,
      updatedAt: Date.now(),
      ...extra,
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
    writeInfo(path, process.pid, { updatedAt: 3, processStart: "boot:7" });
    expect(readHolderInfo(path)).toEqual({
      pid: process.pid,
      token: "t",
      databaseBytes: 1,
      expectedMs: 2,
      phase: "migrating",
      updatedAt: 3,
      processStart: "boot:7",
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

  it.skipIf(process.platform !== "linux")(
    "ignores a marker whose pid was reused by another process",
    () => {
      const path = databasePath();
      const recorded = processIdentity(process.pid);
      expect(recorded).not.toBeNull();
      writeInfo(path, process.pid, { processStart: recorded });
      expect(readActiveMigration(path)?.pid).toBe(process.pid);
      writeInfo(path, process.pid, { processStart: "other-boot:1" });
      expect(readHolderInfo(path)).not.toBeNull();
      expect(readActiveMigration(path)).toBeNull();
    },
  );

  it("tells a live process apart from a later process on the same pid", () => {
    const path = databasePath();
    writeInfo(path, process.pid, {
      processStart: processIdentity(process.pid),
    });
    const identities = new Map([[process.pid, "reused-start"]]);
    expect(
      readActiveMigration(path, {
        identityOf: (pid) => identities.get(pid) ?? null,
      }),
    ).toBeNull();
  });

  it("ignores a marker older than the migration wait cap", () => {
    const path = databasePath();
    writeInfo(path, process.pid, { updatedAt: 1_000 });
    expect(
      readActiveMigration(path, { now: () => 1_000 + 5_000 }),
    ).not.toBeNull();
    expect(
      readActiveMigration(path, { now: () => 1_000 + 60 * 60 * 1000 + 1 }),
    ).toBeNull();
  });

  it("accepts a marker without a recorded process start", () => {
    const path = databasePath();
    writeInfo(path, process.pid);
    expect(readActiveMigration(path)?.pid).toBe(process.pid);
  });

  it("reads a stable identity for the running process", () => {
    expect(processIdentity(process.pid)).toBe(processIdentity(process.pid));
    expect(processIdentity(deadPid())).toBeNull();
  });

  it("detects live and dead processes", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });
});
