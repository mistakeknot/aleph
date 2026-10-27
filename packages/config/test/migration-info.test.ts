import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  processIdentity,
  migratingInfoPath,
  readActiveMigration,
  readActiveStartup,
  readHolderInfo,
  removeStartupMarker,
  startupMarkerPath,
  writeStartupMarker,
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

  it("ignores a marker whose pid was reused by another process", () => {
    const path = databasePath();
    writeInfo(path, process.pid, { processStart: "boot:1" });
    expect(readHolderInfo(path)).not.toBeNull();
    expect(readActiveMigration(path, { identityOf: () => "boot:1" })?.pid).toBe(
      process.pid,
    );
    expect(
      readActiveMigration(path, { identityOf: () => "boot:2" }),
    ).toBeNull();
  });

  it("trusts a marker when the current identity cannot be read", () => {
    const path = databasePath();
    writeInfo(path, process.pid, { processStart: "boot:1" });
    expect(readActiveMigration(path, { identityOf: () => null })?.pid).toBe(
      process.pid,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "reads a stable identity for a live process on linux",
    () => {
      const recorded = processIdentity(process.pid);
      expect(recorded).not.toBeNull();
      expect(processIdentity(process.pid)).toBe(recorded);
    },
  );

  it("publishes and clears a startup marker owned by this process", () => {
    const path = databasePath();
    expect(readActiveStartup(path)).toBeNull();
    writeStartupMarker(path);
    expect(existsSync(startupMarkerPath(path))).toBe(true);
    expect(readActiveStartup(path)?.pid).toBe(process.pid);
    removeStartupMarker(path);
    expect(existsSync(startupMarkerPath(path))).toBe(false);
    expect(readActiveStartup(path)).toBeNull();
  });

  it("leaves a startup marker owned by another process in place", () => {
    const path = databasePath();
    writeFileSync(
      startupMarkerPath(path),
      JSON.stringify({ pid: process.pid + 1, updatedAt: Date.now() }),
    );
    removeStartupMarker(path);
    expect(existsSync(startupMarkerPath(path))).toBe(true);
  });

  it("ignores a startup marker from a dead, reused or overdue process", () => {
    const path = databasePath();
    const write = (pid: number, extra: Record<string, unknown> = {}): void =>
      writeFileSync(
        startupMarkerPath(path),
        JSON.stringify({ pid, updatedAt: Date.now(), ...extra }),
      );
    write(process.pid, { processStart: "boot:1" });
    expect(readActiveStartup(path, { identityOf: () => "boot:1" })?.pid).toBe(
      process.pid,
    );
    expect(readActiveStartup(path, { identityOf: () => "boot:2" })).toBeNull();
    expect(
      readActiveStartup(path, { now: () => Date.now() + 60 * 60 * 1000 + 1 }),
    ).toBeNull();
    write(deadPid());
    expect(readActiveStartup(path)).toBeNull();
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
