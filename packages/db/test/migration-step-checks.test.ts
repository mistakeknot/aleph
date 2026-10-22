import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, type DbConnection } from "../src/index.js";
import { migrateWithFolders, type ForeignKeyReport } from "../src/migrate.js";
import { MigrationStepCheckError } from "../src/migration-step-checks.js";
import { populatedPrefixDatabase } from "./helpers/migration-scenarios.js";
import { sourceFolders } from "./helpers/plan-apply.js";

const tempDirs: string[] = [];
const openDatabases: DbConnection[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.$client.close();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fingerprint(db: DbConnection): string {
  return createHash("sha256").update(db.$client.serialize()).digest("hex");
}

function alephFolderWithA0010(sql: string, checks?: object): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-step-checks-aleph-"));
  tempDirs.push(folder);
  cpSync(sourceFolders.alephFolder, folder, { recursive: true });
  const manifestPath = join(folder, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    steps: Array<{ id: string; file: string; after: string; when: number }>;
  };
  const last = manifest.steps[manifest.steps.length - 1];
  if (last === undefined) throw new Error("Manifest is empty");
  manifest.steps.push({
    id: "A0010",
    file: "A0010_synthetic.sql",
    after: last.id,
    when: last.when + 1000,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(folder, "A0010_synthetic.sql"), sql);
  if (checks !== undefined) {
    const checksPath = join(folder, "step-checks.json");
    const existing = JSON.parse(readFileSync(checksPath, "utf8")) as object;
    writeFileSync(checksPath, JSON.stringify({ ...existing, A0010: checks }));
  }
  return folder;
}

async function migratedPopulatedDatabase(): Promise<DbConnection> {
  const db = await populatedPrefixDatabase(152);
  openDatabases.push(db);
  migrate(db);
  return db;
}

function runA0010(
  db: DbConnection,
  sql: string,
  checks?: object,
  options: Parameters<typeof migrateWithFolders>[2] = {},
): void {
  migrateWithFolders(
    db,
    {
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder: alephFolderWithA0010(sql, checks),
    },
    options,
  );
}

function expectRefused(
  db: DbConnection,
  sql: string,
  message: RegExp,
  checks?: object,
): void {
  const before = fingerprint(db);
  let thrown: unknown;
  try {
    runA0010(db, sql, checks);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MigrationStepCheckError);
  expect((thrown as Error).message).toMatch(message);
  expect(fingerprint(db)).toBe(before);
}

const BREAK = "\n--> statement-breakpoint\n";

describe("per-step safety checks", () => {
  it("applies A0009 on a populated database", async () => {
    const db = await migratedPopulatedDatabase();
    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM __bb_migration_ledger WHERE tag LIKE ?",
        )
        .get("A0009%"),
    ).toEqual({ n: 1 });
  });

  it("accepts a declared no-op step", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(db, "SELECT 1;", {});
    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM __bb_migration_ledger WHERE tag LIKE ?",
        )
        .get("A0010%"),
    ).toEqual({ n: 1 });
  });

  it("refuses an undeclared table create", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "CREATE TABLE zz_new (id INTEGER PRIMARY KEY);",
      /zz_new/,
    );
  });

  it("accepts a declared table create", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(db, "CREATE TABLE zz_new (id INTEGER PRIMARY KEY);", {
      createsTables: ["zz_new"],
    });
    expect(
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE name = 'zz_new'")
        .get(),
    ).toEqual({ name: "zz_new" });
  });

  it("refuses an undeclared table drop", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(db, "DROP TABLE app_settings_values;", /app_settings_values/);
  });

  it("refuses an undeclared row delta", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "DELETE FROM app_settings_values;",
      /app_settings_values/,
    );
  });

  it("refuses an undeclared content change with equal counts", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "UPDATE app_settings_values SET value = value || 'x';",
      /app_settings_values/,
    );
  });

  it("accepts a declared content change", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(db, "UPDATE app_settings_values SET value = value || 'x';", {
      writesTables: ["app_settings_values"],
    });
  });

  it("refuses rowid renumbering of an undeclared table", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "UPDATE app_settings_values SET rowid = rowid + 1000;",
      /app_settings_values/,
      { writesTables: ["app_settings_values"] },
    );
  });

  it("refuses a write that reaches a table through a trigger", async () => {
    const db = await migratedPopulatedDatabase();
    const sql = [
      "CREATE TRIGGER zz_copy AFTER UPDATE ON app_settings_values BEGIN INSERT INTO app_settings_values (key, value, updated_at) VALUES ('zz:' || NEW.key, NEW.value, NEW.updated_at); END;",
      "UPDATE app_settings_values SET updated_at = updated_at + 1;",
      "DROP TRIGGER zz_copy;",
    ].join(BREAK);
    expectRefused(db, sql, /app_settings_values/);
  });

  it("refuses a drop of sqlite_sequence counters", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client
      .prepare(
        "INSERT INTO environment_variables (project_id, name, ciphertext, encryption_version, updated_at) VALUES (NULL, 'ZZ', 'c', 1, 1)",
      )
      .run();
    expectRefused(
      db,
      "UPDATE sqlite_sequence SET seq = 0 WHERE name = 'environment_variables';",
      /sqlite_sequence|environment_variables/,
    );
  });

  it("refuses duplicate sqlite_sequence rows", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "INSERT INTO sqlite_sequence (name, seq) VALUES ('transfer_events', 1);",
      /sqlite_sequence|transfer_events/,
    );
  });

  it("refuses FTS drift from the segments table", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "INSERT INTO thread_search_segments_fts (rowid, text) VALUES (999999, 'zz');",
      /thread_search_segments/,
    );
  });

  it("refuses a table rebuild that loses a preserved column", async () => {
    const db = await migratedPopulatedDatabase();
    const sql = [
      "CREATE TABLE zz_app_settings_values (key text PRIMARY KEY NOT NULL, value text, updated_at integer);",
      "INSERT INTO zz_app_settings_values (key, value, updated_at) SELECT key, NULL, updated_at FROM app_settings_values;",
      "DROP TABLE app_settings_values;",
      "ALTER TABLE zz_app_settings_values RENAME TO app_settings_values;",
    ].join(BREAK);
    expectRefused(db, sql, /app_settings_values/, {
      copiedTables: [
        {
          table: "app_settings_values",
          preservedColumns: ["key", "value", "updated_at"],
          columnRenames: {},
        },
      ],
      createsTables: ["zz_app_settings_values"],
      dropsTables: ["app_settings_values"],
      tableRenames: { zz_app_settings_values: "app_settings_values" },
    });
  });

  it("fails an undeclared Aleph step that changes a table", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "UPDATE app_settings_values SET updated_at = updated_at + 1;",
      /app_settings_values/,
    );
  });

  it("refuses a step that orphans a row without changing counts", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "UPDATE prompt_history_entries SET thread_id = 'zz-missing-thread';",
      /new foreign key violations/,
      { writesTables: ["prompt_history_entries"] },
    );
  });

  it("reports foreign key identities while the frozen segment runs", async () => {
    const db = await populatedPrefixDatabase(131);
    openDatabases.push(db);
    const reports: ForeignKeyReport[] = [];
    migrate(db, { onForeignKeyReport: (report) => reports.push(report) });
    expect(reports).toEqual([{ segment: "frozen", newIdentities: 0 }]);
  });
});
