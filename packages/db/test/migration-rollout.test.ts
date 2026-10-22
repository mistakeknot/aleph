import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  createConnection,
  createThread,
  migrate,
  noopNotifier,
  type DbConnection,
} from "../src/index.js";
import { migrateWithFolders } from "../src/migrate.js";
import { MigrationStateUnknown } from "../src/migration-ledger.js";
import { alephFolderWithSyntheticStep } from "./helpers/aleph-step-folder.js";
import { applyPrefix } from "./helpers/legacy-oracle.js";
import {
  contentOnly,
  describeDatabase,
  diffDescriptions,
} from "./helpers/migration-equality.js";
import {
  RELEASE_PREFIX_LENGTHS,
  legacyMigrate,
  populatedPrefixDatabase,
  populatedUpstreamDatabase,
} from "./helpers/migration-scenarios.js";
import { sourceFolders } from "./helpers/plan-apply.js";
import { populateDatabase } from "./helpers/populate.js";

const TIMEOUT = 300_000;
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const childScript = join(here, "helpers", "migrate-child.ts");

const tempDirs: string[] = [];
const openDatabases: DbConnection[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-rollout-"));
  tempDirs.push(directory);
  return directory;
}

function track(db: DbConnection): DbConnection {
  openDatabases.push(db);
  return db;
}

function describeFile(path: string) {
  const raw = new Database(path, { readonly: true });
  try {
    return describeDatabase(raw);
  } finally {
    raw.close();
  }
}

function contentDiff(
  expected: ReturnType<typeof describeDatabase>,
  actual: ReturnType<typeof describeDatabase>,
): string[] {
  return diffDescriptions(contentOnly(expected), contentOnly(actual)).filter(
    (line) =>
      !/^table differs: (__bb_migration_ledger|app_settings_values) \((\d+) rows \w+ vs \2 rows \w+\)$/.test(
        line,
      ),
  );
}

function foreignKeyViolations(db: DbConnection): string[] {
  const counts = new Map<string, number>();
  for (const row of db.$client.pragma("foreign_key_check") as Array<{
    table: string;
    parent: string;
    fkid: number;
  }>) {
    const key = `${row.table}|${row.parent}|${row.fkid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key}=${n}`).sort();
}

function backupsOf(path: string): string[] {
  return readdirSync(dirname(path)).filter(
    (entry) => entry.includes(".pre-ns-") && !entry.endsWith(".sidecar.json"),
  );
}

function populatedFileDatabase(length: number): string {
  const path = join(tempDir(), "bb.db");
  const raw = new Database(path);
  applyPrefix(raw, length);
  const { failed } = populateDatabase(raw);
  if (Object.keys(failed).length > 0)
    throw new Error(`Populate failed: ${JSON.stringify(failed)}`);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  return path;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(
  path: string,
  point: string,
  alephFolder = sourceFolders.alephFolder,
): Promise<ChildResult> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        childScript,
        path,
        point,
        sourceFolders.upstreamFolder,
        alephFolder,
      ],
      { cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolveChild({ code, signal, stdout, stderr }),
    );
  });
}

function insertMessage(
  db: DbConnection,
  threadId: string,
  id: string,
  extra: {
    forwardSourceRowId?: string;
    claimedAt?: number;
    claimToken?: string;
  } = {},
): void {
  db.$client
    .prepare(
      `INSERT INTO queued_thread_messages (
        id, thread_id, state, content, model, reasoning_level, permission_mode,
        service_tier, group_with_next, forward_source_row_id, claimed_at,
        claim_token, sort_key, created_at, updated_at
      ) VALUES (
        @id, @threadId, @state, '[]', 'gpt-5', 'medium', 'full', 'default', 0,
        @forwardSourceRowId, @claimedAt, @claimToken, @id, 1000, 1000
      )`,
    )
    .run({
      id,
      threadId,
      state: extra.claimedAt === undefined ? "queued" : "claimed",
      forwardSourceRowId: null,
      claimedAt: null,
      claimToken: null,
      ...extra,
    });
}

function messageIds(db: DbConnection): string[] {
  return (
    db.$client
      .prepare("SELECT id FROM queued_thread_messages ORDER BY id")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function newThread(db: DbConnection): string {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
  }).id;
}

describe("triggers after an upgrade", () => {
  it.each([131, 146, 152])(
    "fires the queued-message and soft-delete triggers after upgrading from prefix %i",
    (length) => {
      const db = track(createConnection(":memory:"));
      applyPrefix(db.$client, length);
      migrate(db);
      const first = newThread(db);
      const second = newThread(db);

      insertMessage(db, first, "src");
      expect(
        db.$client
          .prepare("SELECT origin_id AS origin FROM queued_thread_messages")
          .get(),
      ).toEqual({ origin: "src" });

      insertMessage(db, second, "slot", {
        forwardSourceRowId: "src",
        claimedAt: 1,
        claimToken: "slot:one",
      });
      expect(() =>
        insertMessage(db, second, "bad-slot", {
          forwardSourceRowId: "src",
        }),
      ).toThrow();
      expect(() =>
        db.$client
          .prepare(
            "UPDATE queued_thread_messages SET claimed_at = NULL WHERE id = 'slot'",
          )
          .run(),
      ).toThrow();

      db.$client
        .prepare("DELETE FROM queued_thread_messages WHERE id = 'src'")
        .run();
      expect(messageIds(db)).toEqual([]);

      insertMessage(db, first, "src2");
      insertMessage(db, second, "slot2", {
        forwardSourceRowId: "src2",
        claimedAt: 1,
        claimToken: "slot:two",
      });
      db.$client
        .prepare("UPDATE threads SET deleted_at = 5 WHERE id = ?")
        .run(second);
      expect(messageIds(db)).not.toContain("slot2");
    },
  );
});

describe("the previous runner opens a migrated database", () => {
  it.each(RELEASE_PREFIX_LENGTHS)(
    "leaves the schema, data and compatibility log alone from prefix %i",
    async (length) => {
      const db = track(await populatedPrefixDatabase(length));
      migrate(db);
      const before = describeDatabase(db.$client);
      const compatBefore = db.$client
        .prepare(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid",
        )
        .all();

      await legacyMigrate(db);

      expect(contentDiff(before, describeDatabase(db.$client))).toEqual([]);
      expect(
        db.$client
          .prepare(
            "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid",
          )
          .all(),
      ).toEqual(compatBefore);
    },
    TIMEOUT,
  );

  it("still serves the previous release's statements on the result", async () => {
    const db = track(await populatedPrefixDatabase(152));
    migrate(db);
    const violations = foreignKeyViolations(db);
    await legacyMigrate(db);
    const thread = newThread(db);
    insertMessage(db, thread, "from-old-binary", {
      claimedAt: 7,
      claimToken: "fill:old",
    });
    db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(thread);
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM events").get() as {
        n: number;
      },
    ).toBeDefined();
    expect(messageIds(db)).toContain("from-old-binary");
    expect(foreignKeyViolations(db)).toEqual(violations);
  });
});

describe("downgrade honesty", () => {
  it("lets the previous runner open a database that has one genuinely new step and keeps the new table", async () => {
    const db = track(await populatedPrefixDatabase(152));
    migrate(db);
    const alephFolder = alephFolderWithSyntheticStep(
      "CREATE TABLE zz_after_release (id TEXT PRIMARY KEY);",
      { createsTables: ["zz_after_release"] },
    );
    tempDirs.push(alephFolder);
    migrateWithFolders(db, {
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder,
    });
    const compatBefore = db.$client
      .prepare("SELECT hash, created_at FROM __drizzle_migrations")
      .all();

    await legacyMigrate(db);

    expect(
      db.$client
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ?")
        .get("zz_after_release"),
    ).toEqual({ present: 1 });
    expect(
      db.$client
        .prepare("SELECT hash, created_at FROM __drizzle_migrations")
        .all(),
    ).toEqual(compatBefore);
  });
});

describe("foreign keys stay enforced across the upgrade", () => {
  it.each([131, 152])(
    "keeps every row that references threads or queued messages from prefix %i",
    async (length) => {
      const db = track(await populatedPrefixDatabase(length));
      db.$client.pragma("foreign_keys = ON");
      const referencing = (
        db.$client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      )
        .map((row) => row.name)
        .filter((name) =>
          (
            db.$client.pragma(
              `foreign_key_list(${JSON.stringify(name)})`,
            ) as Array<{
              table: string;
            }>
          ).some(
            (edge) =>
              edge.table === "threads" ||
              edge.table === "queued_thread_messages",
          ),
        );
      expect(referencing.length).toBeGreaterThan(0);
      const count = (name: string): number =>
        (
          db.$client
            .prepare(`SELECT count(*) AS n FROM ${JSON.stringify(name)}`)
            .get() as { n: number }
        ).n;
      const before = new Map(referencing.map((name) => [name, count(name)]));
      const violations = foreignKeyViolations(db);

      migrate(db);

      for (const [name, rows] of before) expect(count(name)).toBe(rows);
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(foreignKeyViolations(db)).toEqual(violations);
    },
    TIMEOUT,
  );
});

describe("a migration killed in another process", () => {
  it(
    "rolls back a kill in the middle of the transaction and then completes",
    async () => {
      const path = populatedFileDatabase(131);
      const before = describeFile(path);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);
      const expected = describeDatabase(referenceDb.$client);

      const killed = await runChild(path, "mid-transaction");
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.stdout).not.toContain("migrated");

      expect(contentDiff(before, describeFile(path))).toEqual([]);

      const db = track(createConnection(path));
      migrate(db);
      expect(contentDiff(expected, describeDatabase(db.$client))).toEqual([]);
      expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(foreignKeyViolations(db)).toEqual(
        foreignKeyViolations(referenceDb),
      );
    },
    TIMEOUT,
  );

  it(
    "keeps a committed migration when the process dies after the backup is finalized",
    async () => {
      const path = populatedFileDatabase(131);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);
      const expected = describeDatabase(referenceDb.$client);

      const killed = await runChild(path, "after-backup-finalized");
      expect(killed.signal).toBe("SIGKILL");

      const db = track(createConnection(path));
      const reports: unknown[] = [];
      migrate(db, { onBackup: (report) => reports.push(report) });
      expect(reports).toEqual([]);
      expect(contentDiff(expected, describeDatabase(db.$client))).toEqual([]);
      expect(backupsOf(path)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "lets two processes race the mapping, with one winner and one backup",
    async () => {
      const path = populatedFileDatabase(131);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);
      const expected = describeDatabase(referenceDb.$client);

      const results = await Promise.all([
        runChild(path, "none"),
        runChild(path, "none"),
      ]);
      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("migrated");
      }

      expect(contentDiff(expected, describeFile(path))).toEqual([]);
      expect(backupsOf(path)).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe("ledger shapes the classifier refuses before any step runs", () => {
  function expectRefusedUnchanged(db: DbConnection): void {
    const before = describeDatabase(db.$client);
    let thrown: unknown;
    try {
      migrate(db);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationStateUnknown);
    expect(describeDatabase(db.$client)).toEqual(before);
  }

  it("refuses an unknown past row on a full legacy ledger", async () => {
    const db = track(await populatedPrefixDatabase(152));
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run("unknown-past-step", 1);
    expectRefusedUnchanged(db);
  });

  it("refuses an unknown future row on a full legacy ledger", async () => {
    const db = track(await populatedPrefixDatabase(152));
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run("unknown-future-step", Date.now() + 86_400_000);
    expectRefusedUnchanged(db);
  });

  it("refuses a junk hash at the created_at of a canonical step", async () => {
    const db = track(await populatedPrefixDatabase(152));
    db.$client.exec(
      "INSERT INTO __drizzle_migrations (hash, created_at) SELECT 'junk-hash', created_at FROM __drizzle_migrations WHERE rowid = 70",
    );
    expectRefusedUnchanged(db);
  });

  it("refuses a ledger whose every created_at is NULL", async () => {
    const db = track(await populatedPrefixDatabase(152));
    db.$client.exec("UPDATE __drizzle_migrations SET created_at = NULL");
    expectRefusedUnchanged(db);
  });

  it("refuses a ledger written by upstream bb with 0143 recorded and no A0009", async () => {
    const db = track(await populatedUpstreamDatabase());
    expectRefusedUnchanged(db);
  });
});
