import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMigrationBackup,
  finalizeMigrationBackup,
} from "@bb/db/migration-backup";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import { registerDbCommands } from "../../commands/db.js";

describe("bb db restore-migration-backup", () => {
  setupCommandOutputTestEnvironment();
  let directory: string;
  let databasePath: string;
  let backupPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bb-db-command-"));
    databasePath = join(directory, "bb.db");
    const db = new Database(databasePath);
    db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); INSERT INTO t(v) VALUES ('a'), ('b');",
    );
    db.close();
    const backup = createMigrationBackup(databasePath);
    finalizeMigrationBackup(databasePath, backup);
    backupPath = backup.path;
    const later = new Database(databasePath);
    later.exec("INSERT INTO t(v) VALUES ('c'); CREATE TABLE extra (x);");
    later.close();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function rowCount(): number {
    const db = new Database(databasePath, { readonly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number })
        .n;
    } finally {
      db.close();
    }
  }

  it("verifies with --check and changes nothing", async () => {
    await runCommand(
      ["db", "restore-migration-backup", backupPath, "--check", "--json"],
      registerDbCommands,
    );
    const payload = JSON.parse(
      collectLogPayloads(vi.mocked(console.log)).at(-1) ?? "{}",
    );
    expect(payload.mode).toBe("check");
    expect(payload.rows).toBe(2);
    expect(rowCount()).toBe(3);
  });

  it("restores the database and reports the broken copy", async () => {
    await runCommand(
      ["db", "restore-migration-backup", backupPath],
      registerDbCommands,
    );
    expect(rowCount()).toBe(2);
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines[0]).toContain("Restored");
    expect(lines[1]).toContain(".broken-");
    expect(lines[2]).toContain("Content digest compared");
    expect(lines[3]).toContain("target (older) binary");
  });

  it("restores over an explicit --database path", async () => {
    const other = join(directory, "other.db");
    const seed = new Database(other);
    seed.exec("CREATE TABLE unrelated (x)");
    seed.close();
    await runCommand(
      [
        "db",
        "restore-migration-backup",
        backupPath,
        "--database",
        other,
        "--allow-source-mismatch",
        "--json",
      ],
      registerDbCommands,
    );
    const payload = JSON.parse(
      collectLogPayloads(vi.mocked(console.log)).at(-1) ?? "{}",
    );
    expect(payload.databasePath).toBe(other);
    expect(rowCount()).toBe(3);
  });

  it("refuses a --database target with a different name without the override", async () => {
    const other = join(directory, "other.db");
    const seed = new Database(other);
    seed.exec("CREATE TABLE unrelated (x)");
    seed.close();
    await expect(
      runCommand(
        ["db", "restore-migration-backup", backupPath, "--database", other],
        registerDbCommands,
      ),
    ).rejects.toThrow("process.exit:1");
  });

  it("exits 1 with the engine's reason when the backup is refused", async () => {
    await expect(
      runCommand(
        [
          "db",
          "restore-migration-backup",
          join(directory, "bb.db.pre-ns-none"),
        ],
        registerDbCommands,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain(
      "does not exist",
    );
    expect(rowCount()).toBe(3);
  });
});
