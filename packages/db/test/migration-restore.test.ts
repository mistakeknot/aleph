import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentDigest,
  countUserTables,
  createMigrationBackup,
  finalizeMigrationBackup,
  sequenceDigest,
  SIDECAR_SUFFIX,
} from "../src/migration-backup.js";
import { acquireInUseLock } from "../src/migration-lock.js";
import {
  liveDatabasePathFor,
  MigrationRestoreError,
  restoreMigrationBackup,
} from "../src/migration-restore.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-restore-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const SETUP = `
  PRAGMA user_version = 42;
  CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
  CREATE TABLE child (
    id TEXT PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
    note TEXT
  );
  CREATE TABLE keyless (a TEXT, b INTEGER);
  CREATE TABLE ranged (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID;
  CREATE INDEX child_parent_idx ON child(parent_id);
  CREATE VIEW child_names AS SELECT c.id, p.name FROM child c JOIN parent p ON p.id = c.parent_id;
  CREATE TABLE audit (n INTEGER);
  CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit(n) VALUES (1); END;
  CREATE VIRTUAL TABLE notes USING fts5(body);
  INSERT INTO parent(name) VALUES ('p1'), ('p2'), ('p3');
  DELETE FROM parent WHERE name = 'p3';
  INSERT INTO child(id, parent_id, note) VALUES ('c1', 1, 'x'), ('c2', 2, NULL);
  INSERT INTO keyless(rowid, a, b) VALUES (5, 'a', 1), (9, 'b', 2), (9000, 'a', 1);
  INSERT INTO ranged VALUES ('k1', 1), ('k2', 2);
  INSERT INTO notes(body) VALUES ('hello world'), ('second note');
`;

interface Scratch {
  directory: string;
  databasePath: string;
  backupPath: string;
  counts: Record<string, number>;
  content: string;
  sequence: string;
}

function digestsOf(path: string): { content: string; sequence: string } {
  const db = new Database(path, { readonly: true });
  try {
    return { content: contentDigest(db), sequence: sequenceDigest(db) };
  } finally {
    db.close();
  }
}

function scratch(finalize = true): Scratch {
  const directory = tempDir();
  const databasePath = join(directory, "bb.db");
  const db = new Database(databasePath);
  db.exec(SETUP);
  db.close();
  const backup = createMigrationBackup(databasePath);
  if (finalize) finalizeMigrationBackup(databasePath, backup);
  const counts = (() => {
    const reader = new Database(databasePath, { readonly: true });
    try {
      return countUserTables(reader);
    } finally {
      reader.close();
    }
  })();
  const digests = digestsOf(databasePath);
  return {
    directory,
    databasePath,
    backupPath: backup.path,
    counts,
    content: digests.content,
    sequence: digests.sequence,
  };
}

function migrateAway(databasePath: string): void {
  const db = new Database(databasePath);
  db.exec(`
    PRAGMA user_version = 99;
    DROP TRIGGER child_audit;
    DROP VIEW child_names;
    DROP TABLE keyless;
    ALTER TABLE parent ADD COLUMN extra TEXT;
    INSERT INTO parent(name) VALUES ('later');
    UPDATE child SET note = 'changed';
    CREATE TABLE upstream_only (id INTEGER PRIMARY KEY);
    INSERT INTO upstream_only DEFAULT VALUES;
  `);
  db.close();
}

function brokenCopies(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes(".broken-"));
}

describe("restoreMigrationBackup", () => {
  it("restores rows, rowids, sequences, schema objects and pragmas exactly", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const result = restoreMigrationBackup(fixture.backupPath);

    expect(result.mode).toBe("restore");
    expect(result.databasePath).toBe(fixture.databasePath);
    expect(result.counts).toEqual(fixture.counts);
    const after = digestsOf(fixture.databasePath);
    expect(after.content).toBe(fixture.content);
    expect(after.sequence).toBe(fixture.sequence);

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(42);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        db
          .prepare("SELECT rowid FROM keyless ORDER BY rowid")
          .all()
          .map((row) => (row as { rowid: number }).rowid),
      ).toEqual([5, 9, 9000]);
      expect(
        db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'parent'")
          .get(),
      ).toEqual({ seq: 3 });
      expect(
        db
          .prepare("SELECT count(*) AS n FROM notes WHERE notes MATCH 'hello'")
          .get(),
      ).toEqual({ n: 1 });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'upstream_only'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'child_audit'")
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("keeps the previous contents in a broken copy and leaves the backup untouched", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const migrated = digestsOf(fixture.databasePath);
    const backupBefore = digestsOf(fixture.backupPath);
    const result = restoreMigrationBackup(fixture.backupPath);

    expect(result.brokenCopyPath).not.toBeNull();
    expect(brokenCopies(fixture.directory)).toHaveLength(1);
    expect(digestsOf(result.brokenCopyPath as string)).toEqual(migrated);
    expect(digestsOf(fixture.backupPath)).toEqual(backupBefore);
    expect(existsSync(`${fixture.backupPath}${SIDECAR_SUFFIX}`)).toBe(true);
  });

  it("restores a backup whose sidecar digest is still pending", () => {
    const fixture = scratch(false);
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    expect(digestsOf(fixture.databasePath).content).toBe(fixture.content);
  });

  it("leaves foreign keys enforced on the restored database", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath);
    try {
      db.pragma("foreign_keys = ON");
      expect(() =>
        db.exec("INSERT INTO child(id, parent_id) VALUES ('bad', 777)"),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it("restores over an explicitly named database", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const other = join(fixture.directory, "other.db");
    const seed = new Database(other);
    seed.exec("CREATE TABLE unrelated (x)");
    seed.close();
    restoreMigrationBackup(fixture.backupPath, {
      databasePath: other,
      allowSourceMismatch: true,
    });
    expect(digestsOf(other).content).toBe(fixture.content);
  });

  it("--check verifies and changes nothing", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const before = digestsOf(fixture.databasePath);
    const result = restoreMigrationBackup(fixture.backupPath, {
      checkOnly: true,
    });
    expect(result.mode).toBe("check");
    expect(result.brokenCopyPath).toBeNull();
    expect(result.counts).toEqual(fixture.counts);
    expect(digestsOf(fixture.databasePath)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  it("refuses a backup whose content changed after it was finalized", () => {
    const fixture = scratch();
    const tamper = new Database(fixture.backupPath);
    tamper.exec("UPDATE child SET note = 'tampered' WHERE id = 'c1'");
    tamper.close();
    migrateAway(fixture.databasePath);
    const before = digestsOf(fixture.databasePath);
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      MigrationRestoreError,
    );
    expect(digestsOf(fixture.databasePath)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  it("refuses a backup whose row counts differ from its sidecar", () => {
    const fixture = scratch();
    const tamper = new Database(fixture.backupPath);
    tamper.exec("DELETE FROM ranged WHERE k = 'k2'");
    tamper.close();
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      /row counts differ/,
    );
  });

  it("refuses a backup with no sidecar", () => {
    const fixture = scratch();
    rmSync(`${fixture.backupPath}${SIDECAR_SUFFIX}`);
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      /no readable sidecar/,
    );
  });

  it("refuses a backup with a journal beside it", () => {
    const fixture = scratch();
    writeFileSync(`${fixture.backupPath}-journal`, "x");
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(/journal/);
  });

  it("refuses a missing or empty backup", () => {
    const directory = tempDir();
    expect(() =>
      restoreMigrationBackup(join(directory, "bb.db.pre-ns-missing")),
    ).toThrow(/does not exist/);
    const empty = join(directory, "bb.db.pre-ns-empty");
    writeFileSync(empty, "");
    expect(() => restoreMigrationBackup(empty)).toThrow(/is empty/);
  });

  it("needs a database path when the backup name carries no marker", () => {
    expect(() => liveDatabasePathFor("/tmp/plain.db")).toThrow(
      /does not look like a migration backup/,
    );
    expect(
      liveDatabasePathFor("/data/bb.db.pre-ns-20260101T000000Z-1-ab"),
    ).toBe("/data/bb.db");
  });

  it("refuses to restore a database that does not exist", () => {
    const fixture = scratch();
    rmSync(fixture.databasePath);
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      /does not exist; nothing to restore over/,
    );
  });

  it("refuses to restore a file over itself", () => {
    const fixture = scratch();
    expect(() =>
      restoreMigrationBackup(fixture.backupPath, {
        databasePath: fixture.backupPath,
        allowSourceMismatch: true,
      }),
    ).toThrow(/same file/);
  });

  it("refuses while another connection holds the database in use", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const before = digestsOf(fixture.databasePath);
    const holder = new Database(fixture.databasePath);
    acquireInUseLock(holder);
    try {
      expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
        /Another process is using/,
      );
    } finally {
      holder.close();
    }
    expect(digestsOf(fixture.databasePath)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  it("--check works on a read-only backup and leaves it byte-identical", () => {
    const fixture = scratch();
    chmodSync(fixture.backupPath, 0o444);
    const before = readFileSync(fixture.backupPath);
    const result = restoreMigrationBackup(fixture.backupPath, {
      checkOnly: true,
    });
    expect(result.mode).toBe("check");
    expect(readFileSync(fixture.backupPath).equals(before)).toBe(true);
  });

  it("recomputes instead of comparing when the sidecar projection differs", () => {
    const fixture = scratch();
    const sidecarPath = `${fixture.backupPath}${SIDECAR_SUFFIX}`;
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    sidecar.projection = "content-v1";
    sidecar.digest = "digest-from-an-older-algorithm";
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    migrateAway(fixture.databasePath);
    const result = restoreMigrationBackup(fixture.backupPath);
    expect(result.digestVerification).toBe("recomputed-projection-differs");
    expect(digestsOf(fixture.databasePath).content).toBe(fixture.content);
  });

  it("reports how the digest was verified", () => {
    const finalized = scratch();
    expect(
      restoreMigrationBackup(finalized.backupPath, { checkOnly: true })
        .digestVerification,
    ).toBe("compared");
    const pending = scratch(false);
    expect(
      restoreMigrationBackup(pending.backupPath, { checkOnly: true })
        .digestVerification,
    ).toBe("recomputed-pending");
  });

  it("refuses a backup taken from a differently named database unless overridden", () => {
    const fixture = scratch();
    const other = join(fixture.directory, "unrelated.db");
    const seed = new Database(other);
    seed.exec("CREATE TABLE unrelated (x); INSERT INTO unrelated VALUES (1)");
    seed.close();
    const before = digestsOf(other);
    expect(() =>
      restoreMigrationBackup(fixture.backupPath, { databasePath: other }),
    ).toThrow(/was taken from bb\.db, not unrelated\.db/);
    expect(digestsOf(other)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
    restoreMigrationBackup(fixture.backupPath, {
      databasePath: other,
      allowSourceMismatch: true,
    });
    expect(digestsOf(other).content).toBe(fixture.content);
  });

  it("refuses a sidecar missing its counts or schema hash with a restore error", () => {
    for (const field of ["counts", "schemaHash"]) {
      const fixture = scratch();
      const sidecarPath = `${fixture.backupPath}${SIDECAR_SUFFIX}`;
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
      delete sidecar[field];
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
        MigrationRestoreError,
      );
    }
  });

  it("maps a locked database to the stop-the-server message", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    const holder = new Database(fixture.databasePath);
    holder.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
        /Another process is using .*stop the server and daemon/,
      );
    } finally {
      holder.close();
    }
  });

  it("can be run twice and reaches the same state", () => {
    const fixture = scratch();
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    expect(digestsOf(fixture.databasePath).content).toBe(fixture.content);
    expect(brokenCopies(fixture.directory)).toHaveLength(2);
  });
});
