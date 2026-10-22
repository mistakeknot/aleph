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
    expectRefused(db, sql, /lost or changed preserved data/, {
      copiedTables: [
        {
          table: "app_settings_values",
          preservedColumns: ["key", "value", "updated_at"],
          columnRenames: {},
        },
      ],
      renumbersRowids: ["app_settings_values"],
    });
  });

  it("follows a declared table rename and compares its contents", async () => {
    const db = await migratedPopulatedDatabase();
    const rename = "ALTER TABLE app_settings_values RENAME TO zz_renamed;";
    runA0010(db, rename, {
      tableRenames: { app_settings_values: "zz_renamed" },
    });
    expect(
      db.$client
        .prepare("SELECT count(*) AS n FROM zz_renamed")
        .get() as object,
    ).toEqual({ n: expect.any(Number) });
  });

  it("refuses a renamed table whose contents changed", async () => {
    const db = await migratedPopulatedDatabase();
    const sql = [
      "ALTER TABLE app_settings_values RENAME TO zz_renamed;",
      "UPDATE zz_renamed SET value = value || 'x';",
    ].join(BREAK);
    expectRefused(db, sql, /app_settings_values/, {
      tableRenames: { app_settings_values: "zz_renamed" },
    });
  });

  it("compares autoincrement counters without rounding", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client
      .prepare(
        "INSERT INTO environment_variables (project_id, name, ciphertext, encryption_version, updated_at) VALUES (NULL, 'ZZ', 'c', 1, 1)",
      )
      .run();
    db.$client
      .prepare(
        "UPDATE sqlite_sequence SET seq = 9223372036854775807 WHERE name = 'environment_variables'",
      )
      .run();
    expectRefused(
      db,
      "UPDATE sqlite_sequence SET seq = 9223372036854775806 WHERE name = 'environment_variables';",
      /autoincrement counter of environment_variables/,
    );
  });

  it("refuses a value change that doubles would round away", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client
      .prepare(
        "INSERT INTO app_settings_values (key, value, updated_at) VALUES ('zz:big', 'v', 9223372036854775807)",
      )
      .run();
    expectRefused(
      db,
      "UPDATE app_settings_values SET updated_at = 9223372036854775806 WHERE key = 'zz:big';",
      /app_settings_values/,
    );
  });

  it("refuses a change to rows that have no key value", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.exec(
      "CREATE TABLE zz_nullkey (id TEXT PRIMARY KEY, v TEXT); INSERT INTO zz_nullkey (id, v) VALUES (NULL, 'a'), (NULL, 'b'), ('k', 'c');",
    );
    expectRefused(
      db,
      "UPDATE zz_nullkey SET v = 'changed' WHERE id IS NULL;",
      /zz_nullkey/,
    );
  });

  it("accepts a step that leaves rows without a key value alone", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.exec(
      "CREATE TABLE zz_nullkey (id TEXT PRIMARY KEY, v TEXT); INSERT INTO zz_nullkey (id, v) VALUES (NULL, 'a'), (NULL, 'b'), ('k', 'c');",
    );
    runA0010(db, "SELECT 1;", {});
  });

  it("accepts A0009 on a pre-state database with a failed row", async () => {
    const db = await populatedPrefixDatabase(150);
    openDatabases.push(db);
    const thread = db.$client
      .prepare("SELECT id FROM threads LIMIT 1")
      .get() as { id: string };
    db.$client
      .prepare(
        "INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, failure_reason, failure_count, next_attempt_at, sort_key, created_at, updated_at) VALUES ('zz-q1', ?, 'c', 'm', 'r', 'p', 's', 'boom', 2, 5, 'a0', 1, 1)",
      )
      .run(thread.id);
    migrate(db);
    expect(
      db.$client
        .prepare(
          "SELECT state, failure_count FROM queued_thread_messages WHERE id = 'zz-q1'",
        )
        .get(),
    ).toEqual({ state: "failed_retrying", failure_count: 2 });
  });

  it("refuses an A0009 copy that diverges from its declared normalization", async () => {
    const db = await populatedPrefixDatabase(150);
    openDatabases.push(db);
    const thread = db.$client
      .prepare("SELECT id FROM threads LIMIT 1")
      .get() as { id: string };
    db.$client
      .prepare(
        "INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, failure_reason, failure_count, next_attempt_at, sort_key, created_at, updated_at) VALUES ('zz-q1', ?, 'c', 'm', 'r', 'p', 's', 'boom', 2, 5, 'a0', 1, 1)",
      )
      .run(thread.id);
    const folder = mkdtempSync(join(tmpdir(), "bb-step-checks-mutated-"));
    tempDirs.push(folder);
    cpSync(sourceFolders.alephFolder, folder, { recursive: true });
    const checksPath = join(folder, "step-checks.json");
    const checks = JSON.parse(readFileSync(checksPath, "utf8")) as {
      A0009: {
        copiedTables: Array<{ normalizedColumns: Record<string, string> }>;
      };
    };
    const normalized = checks.A0009.copiedTables[0]?.normalizedColumns;
    if (normalized === undefined) throw new Error("A0009 has no declaration");
    normalized["failure_count"] = `(${normalized["failure_count"]}) + 1`;
    writeFileSync(checksPath, JSON.stringify(checks));
    const before = fingerprint(db);
    let thrown: unknown;
    try {
      migrateWithFolders(db, {
        upstreamFolder: sourceFolders.upstreamFolder,
        alephFolder: folder,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationStepCheckError);
    expect((thrown as Error).message).toMatch(/normalized columns differ/);
    expect(fingerprint(db)).toBe(before);
  });

  it("refuses an added row that repeats an existing violation", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.pragma("foreign_keys = OFF");
    db.$client.exec(
      "CREATE TABLE zz_fk_parent (id integer PRIMARY KEY); CREATE TABLE zz_fk_child (id integer PRIMARY KEY, a integer REFERENCES zz_fk_parent(id)); INSERT INTO zz_fk_child (a) VALUES (99), (99);",
    );
    db.$client.pragma("foreign_keys = ON");
    expectRefused(
      db,
      "INSERT INTO zz_fk_child (a) VALUES (99);",
      /new foreign key violations/,
      { writesTables: ["zz_fk_child"], rowDeltas: { zz_fk_child: 1 } },
    );
  });

  it("accepts a no-op step on a WITHOUT ROWID table", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.exec(
      "CREATE TABLE zz_norowid (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID; INSERT INTO zz_norowid VALUES ('a', '1'), ('b', '2');",
    );
    runA0010(db, "SELECT 1;", {});
  });

  it("accepts an upstream step that changes only the tables it names", async () => {
    const db = await migratedPopulatedDatabase();
    migrateWithFolders(db, {
      upstreamFolder: upstreamFolderWithCandidates(
        [
          {
            tag: "0144_zz_named",
            sql: [
              "CREATE TABLE zz_named (id integer PRIMARY KEY, v text);",
              "INSERT INTO zz_named (id, v) VALUES (1, 'a');",
              "UPDATE zz_named SET v = 'b';",
              "CREATE TABLE zz_gone (id integer PRIMARY KEY);",
              "DROP TABLE zz_gone;",
            ].join(BREAK),
          },
        ],
        sourceFolders.alephFolder,
      ),
      alephFolder: sourceFolders.alephFolder,
    });
    expect(db.$client.prepare("SELECT v FROM zz_named").get()).toEqual({
      v: "b",
    });
  });

  it("refuses an undeclared upstream delete from a table it names", async () => {
    const db = await migratedPopulatedDatabase();
    const before = fingerprint(db);
    let thrown: unknown;
    try {
      migrateWithFolders(db, {
        upstreamFolder: upstreamFolderWithCandidates(
          [
            {
              tag: "0144_zz_delete",
              sql: "DELETE FROM app_settings_values;",
            },
          ],
          sourceFolders.alephFolder,
        ),
        alephFolder: sourceFolders.alephFolder,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationStepCheckError);
    expect((thrown as Error).message).toMatch(/app_settings_values/);
    expect(fingerprint(db)).toBe(before);
  });

  it("resolves a declaration whose case differs from the table name", async () => {
    const db = await migratedPopulatedDatabase();
    const sql = [
      "CREATE TABLE zz_app_settings_values (key text PRIMARY KEY NOT NULL, value text, updated_at integer);",
      "INSERT INTO zz_app_settings_values (key, value, updated_at) SELECT key, NULL, updated_at FROM app_settings_values;",
      "DROP TABLE app_settings_values;",
      "ALTER TABLE zz_app_settings_values RENAME TO app_settings_values;",
    ].join(BREAK);
    expectRefused(db, sql, /lost or changed preserved data/, {
      copiedTables: [
        {
          table: "APP_SETTINGS_VALUES",
          preservedColumns: ["key", "value", "updated_at"],
          columnRenames: {},
        },
      ],
      renumbersRowids: ["app_settings_values"],
    });
  });

  it("refuses corruption of a table declared dropped in another case", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      "UPDATE app_settings_values SET value = 'corrupt';",
      /still exists/,
      { dropsTables: ["APP_SETTINGS_VALUES"] },
    );
  });

  it("accepts upper-case createsTables and rowDeltas declarations", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(
      db,
      [
        "CREATE TABLE zz_new (id INTEGER PRIMARY KEY);",
        "INSERT INTO zz_new (id) VALUES (1);",
      ].join(BREAK),
      { createsTables: ["ZZ_NEW"], rowDeltas: { ZZ_NEW: 1 } },
    );
  });

  it("accepts upper-case rowDeltas and writesTables for an existing table", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(
      db,
      "DELETE FROM app_settings_values WHERE rowid = (SELECT min(rowid) FROM app_settings_values);",
      {
        writesTables: ["APP_SETTINGS_VALUES"],
        rowDeltas: { APP_SETTINGS_VALUES: -1 },
      },
    );
  });

  it("accepts an upper-case tableRenames declaration", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(db, "ALTER TABLE app_settings_values RENAME TO zz_renamed;", {
      tableRenames: { APP_SETTINGS_VALUES: "zz_renamed" },
    });
  });

  const upperRename = {
    tableRenames: { APP_SETTINGS_VALUES: "ZZ_RENAMED" },
  };
  const renameSql = "ALTER TABLE app_settings_values RENAME TO zz_renamed;";

  it("accepts an unchanged table renamed to an upper-case declared target", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(db, renameSql, upperRename);
  });

  it.each([
    ["corruption", "UPDATE zz_renamed SET value = value || 'x';"],
    [
      "deletion",
      "DELETE FROM zz_renamed WHERE rowid = (SELECT min(rowid) FROM zz_renamed);",
    ],
    ["a rowid change", "UPDATE zz_renamed SET rowid = rowid + 100000;"],
  ])(
    "refuses %s in a table renamed to an upper-case target",
    async (_label, mutation) => {
      const db = await migratedPopulatedDatabase();
      expectRefused(
        db,
        [renameSql, mutation].join(BREAK),
        /app_settings_values/,
        upperRename,
      );
    },
  );

  it("does not report an unchanged orphan in a table renamed to an upper-case target", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.pragma("foreign_keys = OFF");
    db.$client.exec(
      "CREATE TABLE zz_fk_parent (id integer PRIMARY KEY); CREATE TABLE zz_fk_child (id integer PRIMARY KEY, a integer REFERENCES zz_fk_parent(id)); INSERT INTO zz_fk_child (a) VALUES (99);",
    );
    db.$client.pragma("foreign_keys = ON");
    runA0010(db, "ALTER TABLE zz_fk_child RENAME TO zz_fk_moved;", {
      tableRenames: { ZZ_FK_CHILD: "ZZ_FK_MOVED" },
    });
  });

  it("accepts an upper-case column rename declaration with an unchanged orphan", async () => {
    const db = await migratedPopulatedDatabase();
    db.$client.pragma("foreign_keys = OFF");
    db.$client.exec(
      "CREATE TABLE zz_fk_parent (id integer PRIMARY KEY); CREATE TABLE zz_fk_child (id integer PRIMARY KEY, p integer REFERENCES zz_fk_parent(id)); INSERT INTO zz_fk_child (p) VALUES (99);",
    );
    db.$client.pragma("foreign_keys = ON");
    runA0010(db, "ALTER TABLE zz_fk_child RENAME COLUMN p TO q;", {
      columnRenames: { ZZ_FK_CHILD: { P: "Q" } },
    });
  });

  it("accepts a copied table with upper-case preserved and renamed columns", async () => {
    const db = await migratedPopulatedDatabase();
    runA0010(
      db,
      "ALTER TABLE app_settings_values RENAME COLUMN value TO zz_v;",
      {
        writesTables: [],
        copiedTables: [
          {
            table: "APP_SETTINGS_VALUES",
            preservedColumns: ["KEY", "VALUE", "UPDATED_AT"],
            columnRenames: { VALUE: "ZZ_V" },
          },
        ],
      },
    );
  });

  it("refuses corruption of a copied table whose columns are declared in upper case", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(
      db,
      [
        "ALTER TABLE app_settings_values RENAME COLUMN value TO zz_v;",
        "UPDATE app_settings_values SET zz_v = 'corrupt';",
      ].join(BREAK),
      /preserved data/,
      {
        copiedTables: [
          {
            table: "APP_SETTINGS_VALUES",
            preservedColumns: ["KEY", "VALUE", "UPDATED_AT"],
            columnRenames: { VALUE: "ZZ_V" },
          },
        ],
      },
    );
  });

  it("refuses a declaration that matches no table", async () => {
    const db = await migratedPopulatedDatabase();
    expectRefused(db, "SELECT 1;", /zz_missing/, {
      copiedTables: [
        {
          table: "zz_missing",
          preservedColumns: ["id"],
          columnRenames: {},
        },
      ],
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

function upstreamFolderWithCandidates(
  candidates: ReadonlyArray<{ tag: string; sql: string }>,
  alephFolder: string,
): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-step-checks-upstream-"));
  tempDirs.push(folder);
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
    readFileSync(join(alephFolder, "manifest.json"), "utf8"),
  ) as { steps: Array<{ when: number }> };
  let when = Math.max(
    ...journal.entries.map((entry) => entry.when),
    ...manifest.steps.map((step) => step.when),
  );
  for (const candidate of candidates) {
    const last = journal.entries[journal.entries.length - 1];
    if (last === undefined) throw new Error("Journal is empty");
    when += 1000;
    journal.entries.push({
      idx: last.idx + 1,
      version: "6",
      when,
      tag: candidate.tag,
      breakpoints: true,
    });
    writeFileSync(join(folder, `${candidate.tag}.sql`), candidate.sql);
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}
