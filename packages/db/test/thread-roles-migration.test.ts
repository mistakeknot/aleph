import {
  cpSync,
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
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  createConnection,
  createThread,
  migrate,
  noopNotifier,
} from "../src/index.js";
import { migrateWithFolders } from "../src/migrate.js";
import { MigrationStateUnknown } from "../src/migration-ledger.js";
import {
  computeMigrationState,
  loadAlignedMigrationPlan,
} from "../src/migration-runner.js";
import {
  liveDatabasePathFor,
  restoreMigrationBackup,
} from "../src/migration-restore.js";
import { sourceFolders } from "./helpers/plan-apply.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ManifestFile {
  steps: Array<{ id: string; file: string; after: string; when: number }>;
}

function alephFolderWithout(excludedId: string): string {
  const folder = tempDir("bb-roles-aleph-");
  cpSync(sourceFolders.alephFolder, folder, { recursive: true });
  const manifestPath = join(folder, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ManifestFile;
  manifest.steps = manifest.steps.filter((step) => step.id !== excludedId);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const checksPath = join(folder, "step-checks.json");
  const checks = JSON.parse(readFileSync(checksPath, "utf8")) as Record<
    string,
    unknown
  >;
  delete checks[excludedId];
  writeFileSync(checksPath, JSON.stringify(checks));
  const frozenPath = join(folder, "frozen-upstream.json");
  const frozen = JSON.parse(readFileSync(frozenPath, "utf8"));
  frozen.steps = frozen.steps.filter(
    (step: { tag: string }) => step.tag !== "0157_thread_run_state",
  );
  writeFileSync(frozenPath, JSON.stringify(frozen));
  return folder;
}

function upstreamBeforeRunState(): string {
  const folder = tempDir("bb-roles-before-run-state-");
  cpSync(sourceFolders.upstreamFolder, folder, { recursive: true });
  const path = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.entries = journal.entries.filter(
    (step: { tag: string }) => step.tag !== "0157_thread_run_state",
  );
  writeFileSync(path, JSON.stringify(journal));
  return folder;
}

function upstreamFolderWithCandidate(tag: string, sql: string): string {
  const folder = tempDir("bb-roles-upstream-");
  cpSync(sourceFolders.upstreamFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  const manifest = JSON.parse(
    readFileSync(join(sourceFolders.alephFolder, "manifest.json"), "utf8"),
  ) as ManifestFile;
  const last = journal.entries[journal.entries.length - 1];
  if (last === undefined) throw new Error("Journal is empty");
  journal.entries.push({
    idx: last.idx + 1,
    version: "6",
    when:
      Math.max(
        ...journal.entries.map((entry) => entry.when),
        ...manifest.steps.map((step) => step.when),
      ) + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

function lastAlephStepId(): string {
  const manifest = JSON.parse(
    readFileSync(join(sourceFolders.alephFolder, "manifest.json"), "utf8"),
  ) as ManifestFile;
  const last = manifest.steps[manifest.steps.length - 1];
  if (last === undefined) throw new Error("Manifest is empty");
  return last.id;
}

function backupsIn(directory: string): string[] {
  return readdirSync(directory).filter(
    (entry) => entry.includes(".pre-ns-") && !entry.endsWith(".json"),
  );
}

describe("A0016 thread roles migration", () => {
  it("is the tail Aleph step", () => {
    expect(lastAlephStepId()).toBe("A0016");
  });

  it("applies on top of A0015, backs up once and is a no-op on re-run", () => {
    const directory = tempDir("bb-roles-backup-");
    const path = join(directory, "bb.db");
    const previousFolder = alephFolderWithout("A0016");
    const before = createConnection(path);
    try {
      migrateWithFolders(before, {
        upstreamFolder: upstreamBeforeRunState(),
        alephFolder: previousFolder,
      });
      expect(
        before.$client
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_roles'")
          .get(),
      ).toBeUndefined();
    } finally {
      before.$client.close();
    }
    expect(backupsIn(directory)).toEqual([]);

    const backups: unknown[] = [];
    const db = createConnection(path);
    try {
      migrate(db, { onBackup: (info) => backups.push(info) });
      expect(backups).toHaveLength(1);
      expect(backupsIn(directory)).toHaveLength(1);
      expect(
        db.$client
          .prepare(
            "SELECT how FROM __bb_migration_ledger WHERE namespace = 'aleph' AND tag = 'A0016'",
          )
          .get(),
      ).toEqual({ how: "applied" });
      expect(
        db.$client
          .prepare("SELECT name FROM sqlite_master WHERE name = ?")
          .get("thread_roles_holder_cleared"),
      ).toEqual({ name: "thread_roles_holder_cleared" });

      migrate(db, { onBackup: (info) => backups.push(info) });
      expect(backups).toHaveLength(1);
      expect(backupsIn(directory)).toHaveLength(1);
    } finally {
      db.$client.close();
    }
  });

  it("restores the pre-migration database from the backup", () => {
    const directory = tempDir("bb-roles-restore-");
    const path = join(directory, "bb.db");
    const before = createConnection(path);
    try {
      migrateWithFolders(before, {
        upstreamFolder: upstreamBeforeRunState(),
        alephFolder: alephFolderWithout("A0016"),
      });
    } finally {
      before.$client.close();
    }
    const db = createConnection(path);
    try {
      migrate(db);
    } finally {
      db.$client.close();
    }
    const [backup] = backupsIn(directory);
    if (backup === undefined) throw new Error("Expected a backup");
    const backupPath = join(directory, backup);
    expect(liveDatabasePathFor(backupPath)).toBe(path);
    restoreMigrationBackup(backupPath, { databasePath: path });
    const restored = new Database(path, { readonly: true });
    try {
      expect(
        restored
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_roles'")
          .get(),
      ).toBeUndefined();
      expect(
        restored
          .prepare(
            "SELECT 1 FROM __bb_migration_ledger WHERE namespace = 'aleph' AND tag = 'A0016'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      restored.close();
    }
    const again = createConnection(path);
    try {
      migrate(again);
      expect(
        again.$client
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_roles'")
          .get(),
      ).toEqual({ "1": 1 });
    } finally {
      again.$client.close();
    }
  });

  it("makes an older binary refuse a database whose ledger lists A0016", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const older = loadAlignedMigrationPlan({
        upstreamFolder: upstreamBeforeRunState(),
        alephFolder: alephFolderWithout("A0016"),
      });
      expect(() => computeMigrationState(db.$client, older)).toThrow(
        MigrationStateUnknown,
      );
      expect(() =>
        migrateWithFolders(db, {
          upstreamFolder: upstreamBeforeRunState(),
          alephFolder: alephFolderWithout("A0016"),
        }),
      ).toThrow(MigrationStateUnknown);
    } finally {
      db.$client.close();
    }
  });

  it.each([
    "DROP TABLE IF EXISTS thread_roles;",
    "ALTER TABLE thread_roles ADD COLUMN zz_extra TEXT;",
    "CREATE TABLE __new_thread_roles (role TEXT);\n--> statement-breakpoint\nDROP TABLE thread_roles;\n--> statement-breakpoint\nALTER TABLE __new_thread_roles RENAME TO thread_roles;",
  ])(
    "refuses a candidate upstream step that rebuilds thread_roles: %s",
    (sql) => {
      const upstreamFolder = upstreamFolderWithCandidate("0144_synthetic", sql);
      expect(() =>
        loadAlignedMigrationPlan({
          upstreamFolder,
          alephFolder: sourceFolders.alephFolder,
        }),
      ).toThrow(/0144_synthetic.*thread_roles/);
    },
  );

  it("keeps the holder-cleared trigger across a threads table rebuild", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const thread = createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test-provider",
        status: "idle",
      });
      const sqlite = db.$client;
      sqlite.pragma("foreign_keys = OFF");
      sqlite.pragma("legacy_alter_table = ON");
      const create = (
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'threads'")
          .get() as { sql: string }
      ).sql;
      sqlite.exec(
        create.replace(
          /^CREATE TABLE [`"]?threads[`"]?/,
          "CREATE TABLE `__new_threads`",
        ),
      );
      sqlite.exec(`
        INSERT INTO __new_threads SELECT * FROM threads;
        DROP TABLE threads;
        ALTER TABLE __new_threads RENAME TO threads;
      `);
      sqlite.pragma("legacy_alter_table = OFF");
      sqlite.pragma("foreign_keys = ON");
      const trigger = sqlite
        .prepare(
          "SELECT tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' AND name = 'thread_roles_holder_cleared'",
        )
        .get();
      expect(trigger).toEqual({ tbl: "thread_roles" });
      sqlite
        .prepare(
          "INSERT INTO thread_roles (role, thread_id, generation, since, updated_at, updated_by_kind) VALUES ('r', ?, 1, 1, 1, 'cli')",
        )
        .run(thread.id);
      sqlite
        .prepare("UPDATE thread_roles SET thread_id = NULL WHERE role = 'r'")
        .run();
      expect(
        sqlite
          .prepare(
            "SELECT generation, updated_by_kind AS kind FROM thread_roles WHERE role = 'r'",
          )
          .get(),
      ).toEqual({ generation: 2, kind: "system" });
    } finally {
      db.$client.close();
    }
  });

  it("keeps the committed step, its backup and a free lock when finalization fails after commit", () => {
    const directory = tempDir("bb-roles-history-");
    const path = join(directory, "bb.db");
    const before = createConnection(path);
    try {
      migrateWithFolders(before, {
        upstreamFolder: upstreamBeforeRunState(),
        alephFolder: alephFolderWithout("A0016"),
      });
    } finally {
      before.$client.close();
    }
    const db = createConnection(path);
    try {
      expect(() =>
        migrate(db, {
          onBackup: () => {
            throw new Error("post-commit failure");
          },
        }),
      ).toThrow("post-commit failure");
      expect(
        db.$client
          .prepare(
            "SELECT how FROM __bb_migration_ledger WHERE namespace = 'aleph' AND tag = 'A0016'",
          )
          .get(),
      ).toEqual({ how: "applied" });
      expect(backupsIn(directory)).toHaveLength(1);
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.$client.close();
    }
    const probe = new Database(join(directory, "bb.db.migrating.lock"));
    probe.pragma("busy_timeout = 0");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    probe.close();
  });
});
