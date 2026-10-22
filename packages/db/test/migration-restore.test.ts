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
    chmodSync(directory, 0o755);
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

function scratch(finalize = true, extraSql = ""): Scratch {
  const directory = tempDir();
  const databasePath = join(directory, "bb.db");
  const db = new Database(databasePath);
  db.exec(SETUP);
  db.exec(extraSql);
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

  it("--check works on a read-only backup in a read-only directory", () => {
    const fixture = scratch();
    chmodSync(fixture.backupPath, 0o444);
    chmodSync(`${fixture.backupPath}${SIDECAR_SUFFIX}`, 0o444);
    chmodSync(fixture.directory, 0o555);
    const before = readFileSync(fixture.backupPath);
    const result = restoreMigrationBackup(fixture.backupPath, {
      checkOnly: true,
    });
    expect(result.mode).toBe("check");
    expect(readFileSync(fixture.backupPath).equals(before)).toBe(true);
  });

  it("--check works on a WAL-mode backup", () => {
    const fixture = scratch(false, "PRAGMA journal_mode = WAL;");
    const result = restoreMigrationBackup(fixture.backupPath, {
      checkOnly: true,
    });
    expect(result.mode).toBe("check");
  });

  it("removes its private verification copy after success and failure", () => {
    const fixture = scratch();
    const holdingDir = tempDir();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = holdingDir;
    try {
      restoreMigrationBackup(fixture.backupPath, { checkOnly: true });
      expect(readdirSync(holdingDir)).toEqual([]);
      const tamper = new Database(fixture.backupPath);
      tamper.exec("UPDATE child SET note = 'tampered' WHERE id = 'c1'");
      tamper.close();
      expect(() =>
        restoreMigrationBackup(fixture.backupPath, { checkOnly: true }),
      ).toThrow(MigrationRestoreError);
      expect(readdirSync(holdingDir)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("reports an unusable verification directory as a restore error", () => {
    const fixture = scratch();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(fixture.directory, "does-not-exist");
    try {
      expect(() =>
        restoreMigrationBackup(fixture.backupPath, { checkOnly: true }),
      ).toThrow(MigrationRestoreError);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("refuses a backup with a -wal file beside it", () => {
    const fixture = scratch();
    writeFileSync(`${fixture.backupPath}-wal`, "x");
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(/-wal/);
  });

  it("refuses a sidecar with no source", () => {
    const fixture = scratch();
    const sidecarPath = `${fixture.backupPath}${SIDECAR_SUFFIX}`;
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    delete sidecar.source;
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      MigrationRestoreError,
    );
  });

  it("still refuses a corrupt backup when the source guard is overridden", () => {
    const fixture = scratch();
    const tamper = new Database(fixture.backupPath);
    tamper.exec("UPDATE child SET note = 'tampered' WHERE id = 'c1'");
    tamper.close();
    const other = join(fixture.directory, "other.db");
    const seed = new Database(other);
    seed.exec("CREATE TABLE unrelated (x)");
    seed.close();
    expect(() =>
      restoreMigrationBackup(fixture.backupPath, {
        databasePath: other,
        allowSourceMismatch: true,
      }),
    ).toThrow(/content differs/);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  const quotedModules = ["'fts5'", '"fts5"', "[fts5]", "`fts5`", "fts5"];
  const contentlessCases = quotedModules.map((module) => ({
    label: `contentless via ${module}`,
    ddl: `CREATE VIRTUAL TABLE cl USING ${module}(body, content='')`,
    insert: "INSERT INTO cl(rowid, body) VALUES (9, 'hello')",
    table: "cl",
  }));
  const externalCases = quotedModules.map((module) => ({
    label: `external-content via ${module}`,
    ddl: `CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO docs(body) VALUES ('hello there'); CREATE VIRTUAL TABLE ext USING ${module}(body, content='docs', content_rowid='id')`,
    insert: "INSERT INTO ext(rowid, body) VALUES (1, 'hello there')",
    table: "ext",
  }));

  it.each([...contentlessCases, ...externalCases])(
    "refuses a backup holding $label, in --check too",
    ({ ddl, insert, table }) => {
      const fixture = scratch(false, `${ddl}; ${insert}`);
      migrateAway(fixture.databasePath);
      const before = digestsOf(fixture.databasePath);
      for (const checkOnly of [true, false]) {
        expect(() =>
          restoreMigrationBackup(fixture.backupPath, { checkOnly }),
        ).toThrow(new RegExp(`FTS5 table ${table}\\b`));
      }
      expect(digestsOf(fixture.databasePath)).toEqual(before);
      expect(brokenCopies(fixture.directory)).toEqual([]);
    },
  );

  it("still restores the application's own FTS5 table definition", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE \`app_fts\` USING fts5(\n  \`text\`,\n  tokenize = 'unicode61',\n  prefix = '2 3'\n); INSERT INTO app_fts(rowid, text) VALUES (4, 'hello app')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db
          .prepare("SELECT rowid FROM app_fts WHERE app_fts MATCH 'hello'")
          .all(),
      ).toEqual([{ rowid: 4 }]);
    } finally {
      db.close();
    }
  });

  function hiddenRowids(databasePath: string, table: string, alias: string) {
    const db = new Database(databasePath, { readonly: true });
    try {
      return db
        .prepare(`SELECT ${alias} AS r, id FROM ${table} ORDER BY id`)
        .all();
    } finally {
      db.close();
    }
  }

  it("keeps hidden rowids when a column is named rowid", () => {
    const fixture = scratch(
      true,
      `CREATE TABLE shadow (id TEXT PRIMARY KEY, rowid TEXT, payload TEXT); INSERT INTO shadow(_rowid_, id, rowid, payload) VALUES (5, 'a', 'x', 'p'), (99, 'b', 'y', 'q')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    expect(hiddenRowids(fixture.databasePath, "shadow", "_rowid_")).toEqual([
      { r: 5, id: "a" },
      { r: 99, id: "b" },
    ]);
  });

  it("keeps hidden rowids when columns shadow rowid and _rowid_", () => {
    const fixture = scratch(
      true,
      `CREATE TABLE shadow (id TEXT PRIMARY KEY, rowid TEXT, _rowid_ TEXT); INSERT INTO shadow(oid, id) VALUES (7, 'a'), (42, 'b')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    expect(hiddenRowids(fixture.databasePath, "shadow", "oid")).toEqual([
      { r: 7, id: "a" },
      { r: 42, id: "b" },
    ]);
  });

  it("refuses before changing anything when all three rowid names are shadowed", () => {
    const directory = tempDir();
    const databasePath = join(directory, "bb.db");
    const db = new Database(databasePath);
    db.exec(SETUP);
    db.exec(
      `CREATE TABLE shadow (id TEXT PRIMARY KEY, rowid TEXT, _rowid_ TEXT, oid TEXT); INSERT INTO shadow VALUES ('a', 'x', 'y', 'z')`,
    );
    db.close();
    const backup = createMigrationBackup(databasePath);
    const finalization = finalizeMigrationBackup(databasePath, backup);
    expect(finalization.status).toBe("basic");
    migrateAway(databasePath);
    const before = readFileSync(databasePath);
    for (const checkOnly of [true, false]) {
      expect(() => restoreMigrationBackup(backup.path, { checkOnly })).toThrow(
        /shadow rowid, _rowid_ and oid/,
      );
    }
    expect(readFileSync(databasePath).equals(before)).toBe(true);
    expect(brokenCopies(directory)).toEqual([]);
  });

  it("keeps hidden rowids when the integer primary key is descending", () => {
    const fixture = scratch(
      true,
      `CREATE TABLE descending (id INTEGER PRIMARY KEY DESC, v TEXT); INSERT INTO descending(rowid, id, v) VALUES (11, 3, 'a'), (30, 1, 'b')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    expect(hiddenRowids(fixture.databasePath, "descending", "rowid")).toEqual([
      { r: 30, id: 1 },
      { r: 11, id: 3 },
    ]);
  });

  it("restores a rowid-aliasing table named rowid", () => {
    const fixture = scratch(
      true,
      `CREATE TABLE aliased (rowid INTEGER PRIMARY KEY, v TEXT); INSERT INTO aliased VALUES (8, 'a'), (21, 'b')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT rowid, v FROM aliased ORDER BY 1").all(),
      ).toEqual([
        { rowid: 8, v: "a" },
        { rowid: 21, v: "b" },
      ]);
    } finally {
      db.close();
    }
  });

  it("restores an R-tree table that has ordinary geo_config and geo_data tables", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE geo USING rtree(id, minx, maxx); CREATE TABLE geo_config (k TEXT); CREATE TABLE geo_data (k TEXT); INSERT INTO geo VALUES (3, 1.0, 2.0); INSERT INTO geo_config VALUES ('c'); INSERT INTO geo_data VALUES ('d')`,
    );
    migrateAway(fixture.databasePath);
    expect(() => restoreMigrationBackup(fixture.backupPath)).not.toThrow(
      /FTS5/,
    );
  });

  it("refuses an external-content FTS5 table whose content table is named like a shadow", () => {
    const fixture = scratch(
      false,
      `CREATE TABLE a_content (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO a_content(body) VALUES ('hello'); CREATE VIRTUAL TABLE a USING fts5(body, content='a_content', content_rowid='id')`,
    );
    migrateAway(fixture.databasePath);
    for (const checkOnly of [true, false]) {
      expect(() =>
        restoreMigrationBackup(fixture.backupPath, { checkOnly }),
      ).toThrow(/FTS5 table a\b/);
    }
  });

  it("refuses an FTS5 table with persistent rank or automerge settings, in --check too", () => {
    const fixture = scratch(
      false,
      `CREATE VIRTUAL TABLE tuned USING fts5(body); INSERT INTO tuned(rowid, body) VALUES (1, 'hello world'), (2, 'hello hello'); INSERT INTO tuned(tuned, rank) VALUES ('rank', 'bm25(10.0)'); INSERT INTO tuned(tuned, rank) VALUES ('automerge', 4)`,
    );
    migrateAway(fixture.databasePath);
    const before = digestsOf(fixture.databasePath);
    for (const checkOnly of [true, false]) {
      expect(() =>
        restoreMigrationBackup(fixture.backupPath, { checkOnly }),
      ).toThrow(/FTS5 table tuned with persistent settings/);
    }
    expect(digestsOf(fixture.databasePath)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  it("restores an FTS5 table whose quoted name contains USING(", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE "using(" USING fts5(body); INSERT INTO "using("(rowid, body) VALUES (3, 'hello quoted')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db
          .prepare(`SELECT rowid FROM "using(" WHERE "using(" MATCH 'hello'`)
          .all(),
      ).toEqual([{ rowid: 3 }]);
    } finally {
      db.close();
    }
  });

  it.each([
    "CREATE VIRTUAL TABLE f USING /*comment*/ fts5(body)",
    "CREATE VIRTUAL TABLE f USING fts5/*comment*/(body)",
    "CREATE VIRTUAL TABLE f USING fts5(body, -- note\n tokenize='unicode61')",
  ])("refuses a virtual table definition with an SQL comment: %s", (ddl) => {
    const fixture = scratch(
      false,
      `${ddl}; INSERT INTO f(rowid, body) VALUES (1, 'hello')`,
    );
    migrateAway(fixture.databasePath);
    const before = digestsOf(fixture.databasePath);
    for (const checkOnly of [true, false]) {
      expect(() =>
        restoreMigrationBackup(fixture.backupPath, { checkOnly }),
      ).toThrow(/SQL comment/);
    }
    expect(digestsOf(fixture.databasePath)).toEqual(before);
    expect(brokenCopies(fixture.directory)).toEqual([]);
  });

  it.each([
    "CREATE VIRTUAL TABLE f USING fts5(body, locale=1)",
    "CREATE VIRTUAL TABLE f USING fts5(body, contentless_delete=1, content='')",
  ])(
    "refuses an FTS5 definition outside the round-trip allowlist: %s",
    (ddl) => {
      const fixture = scratch(false, ddl);
      migrateAway(fixture.databasePath);
      const before = digestsOf(fixture.databasePath);
      for (const checkOnly of [true, false]) {
        expect(() =>
          restoreMigrationBackup(fixture.backupPath, { checkOnly }),
        ).toThrow(/FTS5 table f\b/);
      }
      expect(digestsOf(fixture.databasePath)).toEqual(before);
      expect(brokenCopies(fixture.directory)).toEqual([]);
    },
  );

  it("refuses locale=1 values written with fts5_locale", () => {
    const fixture = scratch(
      false,
      `CREATE VIRTUAL TABLE loc USING fts5(body, locale=1); INSERT INTO loc(rowid, body) VALUES (1, fts5_locale('en_US', 'hello'))`,
    );
    migrateAway(fixture.databasePath);
    expect(() => restoreMigrationBackup(fixture.backupPath)).toThrow(
      /FTS5 table loc\b/,
    );
  });

  it("restores FTS5 tables that use only the round-trip options", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE opts USING fts5(title UNINDEXED, "body", tokenize = 'porter unicode61', prefix = '2 3', columnsize = 1, detail = full); INSERT INTO opts(rowid, title, body) VALUES (6, 't', 'running hello')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT rowid FROM opts WHERE opts MATCH 'run'").all(),
      ).toEqual([{ rowid: 6 }]);
    } finally {
      db.close();
    }
  });

  it("restores an FTS5 table whose quoted column name contains =", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE eq USING fts5("a=b", "a,b"); INSERT INTO eq(rowid, "a=b", "a,b") VALUES (3, 'alpha', 'beta')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT rowid FROM eq WHERE eq MATCH 'alpha'").all(),
      ).toEqual([{ rowid: 3 }]);
    } finally {
      db.close();
    }
  });

  it("restores an FTS5 table whose quoted option value contains comment markers", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE marks USING fts5(body, tokenize='unicode61 tokenchars ''--/*'''); INSERT INTO marks(rowid, body) VALUES (2, 'hello')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT rowid FROM marks WHERE marks MATCH 'hello'").all(),
      ).toEqual([{ rowid: 2 }]);
    } finally {
      db.close();
    }
  });

  it("restores an FTS5 table whose bare column name is not ASCII", () => {
    const fixture = scratch(
      true,
      `CREATE VIRTUAL TABLE uni USING fts5(café); INSERT INTO uni(rowid, café) VALUES (5, 'latte')`,
    );
    migrateAway(fixture.databasePath);
    restoreMigrationBackup(fixture.backupPath);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT rowid FROM uni WHERE uni MATCH 'latte'").all(),
      ).toEqual([{ rowid: 5 }]);
    } finally {
      db.close();
    }
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
