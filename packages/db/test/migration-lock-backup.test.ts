import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";
import {
  contentDigest,
  createMigrationBackup,
  finalizeMigrationBackup,
  listMigrationBackups,
  MigrationBackupError,
  readSidecar,
  sequenceDigest,
  SIDECAR_SUFFIX,
  type BackupFinalization,
} from "../src/migration-backup.js";
import {
  acquireInUseLock,
  acquireMigratingLock,
  heldMigrationLockHandleCount,
  inUseLockPath,
  MigrationLockTimeout,
  migratingInfoPath,
  migratingLockPath,
  readHolderInfo,
  waitWhileMigrating,
} from "../src/migration-lock.js";
import { applyPrefix } from "./helpers/legacy-oracle.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-lock-backup-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  collect();
}

function lockIsFree(path: string): boolean {
  const probe = new Database(path);
  probe.pragma("busy_timeout = 0");
  try {
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

function fingerprint(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return createHash("sha256").update(db.serialize()).digest("hex");
  } finally {
    db.close();
  }
}

function legacyFileDatabase(directory: string, length: number): string {
  const path = join(directory, "bb.db");
  const raw = new Database(path);
  applyPrefix(raw, length);
  raw.close();
  return path;
}

function backupsOf(path: string): string[] {
  return readdirSync(join(path, ".."))
    .filter((entry) => entry.includes(".pre-ns-"))
    .sort();
}

describe("migration lock files", () => {
  it("holds in-use while the connection is open and frees it on close", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const db = createConnection(path);
    acquireInUseLock(db.$client);
    expect(lockIsFree(inUseLockPath(path))).toBe(false);
    collectGarbage();
    expect(lockIsFree(inUseLockPath(path))).toBe(false);
    expect(heldMigrationLockHandleCount()).toBe(1);
    db.$client.close();
    expect(lockIsFree(inUseLockPath(path))).toBe(true);
    expect(heldMigrationLockHandleCount()).toBe(0);
  });

  it("holds migrating until released, across garbage collection", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const db = createConnection(path);
    try {
      const lock = acquireMigratingLock(db.$client);
      expect(lock).not.toBeNull();
      collectGarbage();
      expect(lockIsFree(migratingLockPath(path))).toBe(false);
      lock?.release();
      expect(lockIsFree(migratingLockPath(path))).toBe(true);
      expect(heldMigrationLockHandleCount()).toBe(0);
    } finally {
      db.$client.close();
    }
  });

  it("takes no lock files and writes no backups for memory databases", () => {
    const before = readdirSync(process.cwd());
    const db = createConnection(":memory:");
    try {
      acquireInUseLock(db.$client);
      expect(acquireMigratingLock(db.$client)).toBeNull();
      migrate(db);
    } finally {
      db.$client.close();
    }
    expect(readdirSync(process.cwd())).toEqual(before);
    const buffered = createConnection(new Database(":memory:").serialize());
    try {
      expect(acquireMigratingLock(buffered.$client)).toBeNull();
    } finally {
      buffered.$client.close();
    }
  });

  it("makes a second migrating opener wait, then name the holder", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const first = createConnection(path);
    const second = createConnection(path);
    try {
      const lock = acquireMigratingLock(first.$client);
      expect(() =>
        acquireMigratingLock(second.$client, { waitCapMs: 400 }),
      ).toThrow(MigrationLockTimeout);
      try {
        acquireMigratingLock(second.$client, { waitCapMs: 300 });
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationLockTimeout);
        expect((error as MigrationLockTimeout).message).toContain(
          String(process.pid),
        );
      }
      lock?.release();
      const again = acquireMigratingLock(second.$client, { waitCapMs: 400 });
      again?.release();
    } finally {
      first.$client.close();
      second.$client.close();
    }
  });

  it("lets a waiter see a held lock and then pass after release", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const first = createConnection(path);
    const second = createConnection(path);
    try {
      const lock = acquireMigratingLock(first.$client);
      expect(() => waitWhileMigrating(second.$client, 300)).toThrow(
        MigrationLockTimeout,
      );
      expect(() => waitWhileMigrating(second.$client, 300)).toThrow(
        MigrationLockTimeout,
      );
      lock?.release();
      expect(() => waitWhileMigrating(second.$client, 300)).not.toThrow();
    } finally {
      first.$client.close();
      second.$client.close();
    }
  });

  it("removes the holder info file when the lock is released", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const db = createConnection(path);
    try {
      const lock = acquireMigratingLock(db.$client);
      lock?.setPhase("migrating");
      expect(existsSync(migratingInfoPath(path))).toBe(true);
      lock?.release();
      expect(existsSync(migratingInfoPath(path))).toBe(false);
      lock?.release();
    } finally {
      db.$client.close();
    }
  });

  it("releases the handle when the holder info cannot be written", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const db = createConnection(path);
    try {
      mkdirSync(migratingInfoPath(path));
      expect(() => acquireMigratingLock(db.$client)).toThrow();
      expect(heldMigrationLockHandleCount()).toBe(0);
      expect(lockIsFree(migratingLockPath(path))).toBe(true);
    } finally {
      db.$client.close();
    }
  });

  it("frees the lock when a holder process is killed at each phase", async () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    for (const phase of ["classifying", "backup", "migrating", "verifying"]) {
      const script = `
        const Database = require("better-sqlite3");
        const fs = require("node:fs");
        const lock = new Database(${JSON.stringify(migratingLockPath(path))});
        lock.exec("BEGIN EXCLUSIVE");
        fs.writeFileSync(${JSON.stringify(migratingInfoPath(path))}, JSON.stringify({pid: process.pid, token: "t", databaseBytes: 0, expectedMs: 0, phase: ${JSON.stringify(phase)}, updatedAt: Date.now()}));
        process.stdout.write("held\\n");
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(lockIsFree(migratingLockPath(path))).toBe(false);
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
      expect(lockIsFree(migratingLockPath(path))).toBe(true);
    }
  });

  it("does not let shared in-use holders block a migration", () => {
    const directory = tempDir();
    const path = legacyFileDatabase(directory, 131);
    const holder = createConnection(path);
    acquireInUseLock(holder.$client);
    const migrator = createConnection(path);
    try {
      expect(() => migrate(migrator)).not.toThrow();
    } finally {
      migrator.$client.close();
      holder.$client.close();
    }
  });
});

describe("migration backup", () => {
  it("backs up an existing database before the namespace migration", () => {
    const directory = tempDir();
    const path = legacyFileDatabase(directory, 131);
    const before = new Database(path, { readonly: true });
    const beforeDigest = contentDigest(before);
    before.close();
    const reports: BackupFinalization[] = [];
    const db = createConnection(path);
    try {
      migrate(db, { onBackup: (report) => reports.push(report) });
    } finally {
      db.$client.close();
    }
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.status).toBe("verified");
    const [backupPath] = listMigrationBackups(path);
    expect(backupPath).toBeDefined();
    expect(statSync(backupPath ?? "").mode & 0o777).toBe(0o600);
    const sidecar = readSidecar(`${backupPath}${SIDECAR_SUFFIX}`);
    expect(sidecar?.digest).toBe(beforeDigest);
    expect(sidecar?.digest).not.toBe("pending");
    const backup = new Database(backupPath ?? "", { readonly: true });
    expect(contentDigest(backup)).toBe(beforeDigest);
    backup.close();
    expect(
      readdirSync(directory).filter(
        (entry) => entry.endsWith("-journal") || entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
    expect(lockIsFree(migratingLockPath(path))).toBe(true);
    expect(lockIsFree(inUseLockPath(path))).toBe(true);
  });

  it("keeps the migrating marker through backup finalization", () => {
    const directory = tempDir();
    const path = legacyFileDatabase(directory, 131);
    const seen: Array<{ pid: number; phase: string } | null> = [];
    const db = createConnection(path);
    try {
      migrate(db, {
        onBackup: () => {
          const info = readHolderInfo(path);
          seen.push(
            info === null ? null : { pid: info.pid, phase: info.phase },
          );
          expect(lockIsFree(migratingLockPath(path))).toBe(false);
        },
      });
    } finally {
      db.$client.close();
    }
    expect(seen).toEqual([{ pid: process.pid, phase: "finalizing" }]);
    expect(existsSync(migratingInfoPath(path))).toBe(false);
    expect(lockIsFree(migratingLockPath(path))).toBe(true);
  });

  it("makes no backup for a fresh install or an already migrated database", () => {
    const directory = tempDir();
    const path = join(directory, "bb.db");
    const reports: BackupFinalization[] = [];
    const first = createConnection(path);
    migrate(first, { onBackup: (report) => reports.push(report) });
    first.$client.close();
    expect(backupsOf(path)).toEqual([]);
    const second = createConnection(path);
    migrate(second, { onBackup: (report) => reports.push(report) });
    second.$client.close();
    expect(backupsOf(path)).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("finalizes the backup even when no onBackup callback is given", () => {
    const directory = tempDir();
    const path = legacyFileDatabase(directory, 131);
    const db = createConnection(path);
    try {
      migrate(db);
    } finally {
      db.$client.close();
    }
    const [backup] = backupsOf(path).filter(
      (entry) => !entry.endsWith(SIDECAR_SUFFIX),
    );
    const sidecar = readSidecar(join(directory, `${backup}${SIDECAR_SUFFIX}`));
    expect(sidecar?.digest).not.toBe("pending");
  });

  it("leaves backup bytes unchanged and tolerates a sidecar write failure", () => {
    const directory = tempDir();
    const path = scratchDatabase(
      directory,
      "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('a');",
    );
    const backup = createMigrationBackup(path);
    const before = fingerprint(backup.path);
    rmSync(backup.sidecarPath);
    mkdirSync(backup.sidecarPath);
    const report = finalizeMigrationBackup(path, backup);
    expect(report.status).toBe("basic");
    expect(fingerprint(backup.path)).toBe(before);
  });

  it("leaves the database unchanged when the backup cannot be made", () => {
    const directory = tempDir();
    const path = legacyFileDatabase(directory, 131);
    const db = createConnection(path);
    const before = fingerprint(path);
    const original = process.env.SQLITE_TMPDIR;
    process.env.SQLITE_TMPDIR = join(directory, "missing");
    try {
      expect(() => migrate(db)).toThrow(MigrationBackupError);
    } finally {
      db.$client.close();
      if (original === undefined) delete process.env.SQLITE_TMPDIR;
      else process.env.SQLITE_TMPDIR = original;
    }
    expect(fingerprint(path)).toBe(before);
    expect(backupsOf(path)).toEqual([]);
    expect(lockIsFree(migratingLockPath(path))).toBe(true);
  });
});

function scratchDatabase(directory: string, setup: string): string {
  const path = join(directory, "bb.db");
  const db = new Database(path);
  db.exec(setup);
  db.close();
  return path;
}

describe("backup digests and deduplication", () => {
  it("distinguishes characters moved between columns and renumbered rowids", () => {
    const directory = tempDir();
    const left = new Database(join(directory, "a.db"));
    const right = new Database(join(directory, "b.db"));
    const renumbered = new Database(join(directory, "c.db"));
    const schema = "CREATE TABLE t (a TEXT, b TEXT, k TEXT UNIQUE);";
    left.exec(`${schema} INSERT INTO t VALUES ('ab', 'c', 'x');`);
    right.exec(`${schema} INSERT INTO t VALUES ('a', 'bc', 'x');`);
    renumbered.exec(
      `${schema} INSERT INTO t(rowid, a, b, k) VALUES (7, 'ab', 'c', 'x');`,
    );
    expect(contentDigest(left)).not.toBe(contentDigest(right));
    expect(contentDigest(left)).not.toBe(contentDigest(renumbered));
    left.close();
    right.close();
    renumbered.close();
  });

  it("hashes the hidden rowid of a table with a column named rowid", () => {
    const directory = tempDir();
    const left = new Database(join(directory, "a.db"));
    const right = new Database(join(directory, "b.db"));
    const schema = "CREATE TABLE t (rowid TEXT, k TEXT UNIQUE);";
    left.exec(
      `${schema} INSERT INTO t(_rowid_, rowid, k) VALUES (1, 'v', 'x');`,
    );
    right.exec(
      `${schema} INSERT INTO t(_rowid_, rowid, k) VALUES (9, 'v', 'x');`,
    );
    expect(contentDigest(left)).not.toBe(contentDigest(right));
    left.close();
    right.close();
  });

  it("refuses to digest a table that shadows every rowid name", () => {
    const directory = tempDir();
    const db = new Database(join(directory, "a.db"));
    db.exec(
      "CREATE TABLE t (rowid TEXT, _rowid_ TEXT, oid TEXT, k TEXT UNIQUE); INSERT INTO t VALUES ('a', 'b', 'c', 'x');",
    );
    expect(() => contentDigest(db)).toThrow(/shadows every rowid name/);
    db.close();
  });

  it("keeps sequence state out of the content digest", () => {
    const directory = tempDir();
    const plain = new Database(join(directory, "a.db"));
    const bumped = new Database(join(directory, "b.db"));
    const schema =
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);";
    plain.exec(`${schema} INSERT INTO t(id, v) VALUES (1, 'x');`);
    bumped.exec(
      `${schema} INSERT INTO t(id, v) VALUES (100, 'y'); DELETE FROM t; INSERT INTO t(id, v) VALUES (1, 'x');`,
    );
    expect(contentDigest(plain)).toBe(contentDigest(bumped));
    expect(sequenceDigest(plain)).not.toBe(sequenceDigest(bumped));
    plain.close();
    bumped.close();
  });

  it("removes a same-content duplicate but keeps distinct snapshots", () => {
    const directory = tempDir();
    const path = scratchDatabase(
      directory,
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); INSERT INTO t(v) VALUES ('x');",
    );
    const first = createMigrationBackup(path);
    expect(finalizeMigrationBackup(path, first).status).toBe("verified");
    const second = createMigrationBackup(path);
    const duplicate = finalizeMigrationBackup(path, second);
    expect(duplicate.status).toBe("duplicate-removed");
    expect(existsSync(second.path)).toBe(false);
    expect(existsSync(second.sidecarPath)).toBe(false);
    expect(listMigrationBackups(path)).toEqual([first.path]);

    const db = new Database(path);
    db.exec(
      "INSERT INTO t(id, v) VALUES (100, 'y'); DELETE FROM t WHERE id = 100;",
    );
    db.close();
    const sequenceOnly = createMigrationBackup(path);
    expect(finalizeMigrationBackup(path, sequenceOnly).status).toBe("verified");
    expect(listMigrationBackups(path)).toHaveLength(2);

    const edited = new Database(path);
    edited.exec("UPDATE t SET v = 'z'");
    edited.close();
    const changed = createMigrationBackup(path);
    expect(finalizeMigrationBackup(path, changed).status).toBe("verified");
    expect(listMigrationBackups(path)).toHaveLength(3);
  });

  it("keeps both backups when the older one was damaged after its sidecar", () => {
    const directory = tempDir();
    const path = scratchDatabase(
      directory,
      "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x');",
    );
    const older = createMigrationBackup(path);
    finalizeMigrationBackup(path, older);
    truncateSync(older.path, 1024);
    const newer = createMigrationBackup(path);
    expect(finalizeMigrationBackup(path, newer).status).toBe("verified");
    expect(existsSync(newer.path)).toBe(true);
    expect(existsSync(older.path)).toBe(true);
  });

  it("verifies the FTS integrity of the backup", () => {
    const directory = tempDir();
    const path = scratchDatabase(
      directory,
      "CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT); CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id'); INSERT INTO docs(id, body) VALUES (1, 'hello'); INSERT INTO docs_fts(rowid, body) VALUES (1, 'hello');",
    );
    const good = createMigrationBackup(path);
    expect(finalizeMigrationBackup(path, good).status).toBe("verified");
    const db = new Database(path);
    db.exec("INSERT INTO docs(id, body) VALUES (2, 'drift');");
    db.close();
    const drifted = createMigrationBackup(path);
    const report = finalizeMigrationBackup(path, drifted);
    expect(report.status).toBe("basic");
    expect(report.status === "basic" ? report.reason : "").toMatch(/FTS/);
  });
});
