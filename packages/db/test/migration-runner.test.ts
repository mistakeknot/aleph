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
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import { migrateWithFolders } from "../src/migrate.js";
import { legacyMigrationChain } from "../src/legacy-migration-chain.js";
import {
  MigrationGuardError,
  statementIdentifiers,
  statementVerb,
} from "../src/migration-guard.js";
import { MigrationStateUnknown } from "../src/migration-ledger.js";
import {
  computeMigrationState,
  loadAlignedMigrationPlan,
} from "../src/migration-runner.js";
import { applyPrefix } from "./helpers/legacy-oracle.js";
import {
  legacyMigrate,
  openLegacyConnection,
  populatedPrefixDatabase,
} from "./helpers/migration-scenarios.js";
import { sourceFolders } from "./helpers/plan-apply.js";

const tempDirs: string[] = [];

function closeConnection(db: DbConnection): void {
  db.$client.close();
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function upstreamFolderWithCandidate(
  tag: string,
  sql: string,
  alephFolder: string = sourceFolders.alephFolder,
): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-runner-upstream-"));
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
  const last = journal.entries[journal.entries.length - 1];
  if (last === undefined) throw new Error("Journal is empty");
  journal.entries.push({
    idx: last.idx + 1,
    version: "6",
    when:
      Math.max(
        last.when,
        ...loadAlignedMigrationPlan({
          upstreamFolder: sourceFolders.upstreamFolder,
          alephFolder,
        }).plan.steps.map((step) => step.when),
      ) + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

describe("loadAlignedMigrationPlan candidate steps", () => {
  it("accepts an unchanged plan", () => {
    expect(() => loadAlignedMigrationPlan(sourceFolders)).not.toThrow();
  });

  it("refuses an Aleph statement whose target no model knows", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "ALTER TABLE ghost_table ADD COLUMN extra TEXT;" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidate(
      "0144_synthetic",
      "CREATE TABLE unrelated_candidate (id TEXT PRIMARY KEY);",
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(/targets no known table, view, index or trigger/);
  });

  it("discards the backup and frees the lock when a step fails at runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-runner-fail-"));
    tempDirs.push(directory);
    const path = join(directory, "bb.db");
    const prepared = createConnection(path);
    applyPrefix(prepared.$client, 131);
    prepared.$client.close();
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "SELECT abs(-9223372036854775808);" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates([], alephFolder);
    const db = createConnection(path);
    try {
      expect(() =>
        migrateWithFolders(db, { upstreamFolder, alephFolder }),
      ).toThrow();
    } finally {
      db.$client.close();
    }
    expect(
      readdirSync(directory).filter((e) => e.includes(".pre-ns-")),
    ).toEqual([]);
    const probe = new Database(join(directory, "bb.db.migrating.lock"));
    probe.pragma("busy_timeout = 0");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    probe.close();
  });

  it("widens the guard to the trusted table under a candidate-created index", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "DROP INDEX candidate_idx;" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        {
          tag: "0144_candidate_index",
          sql: "CREATE INDEX candidate_idx ON hosts (id);",
        },
        {
          tag: "0145_candidate_alter",
          sql: "ALTER TABLE hosts ADD COLUMN zz_other TEXT;",
        },
      ],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(/0145_candidate_alter.*hosts/);
  });

  it("does not read a table name that only appears in a string literal", () => {
    expect(
      statementIdentifiers("UPDATE app_settings SET value = 'threads'"),
    ).toEqual(["update", "app_settings", "set", "value"]);
    expect(statementIdentifiers("DROP TABLE 'threads'")).toContain("threads");
  });

  it("refuses a candidate that drops an Aleph-owned table", () => {
    const upstreamFolder = upstreamFolderWithCandidate(
      "0144_synthetic",
      "DROP TABLE IF EXISTS aleph_install_requests;",
    );
    expect(() =>
      loadAlignedMigrationPlan({
        upstreamFolder,
        alephFolder: sourceFolders.alephFolder,
      }),
    ).toThrow(/0144_synthetic.*aleph_install_requests/);
  });
});

describe("computeMigrationState history checks", () => {
  it("treats a database with only an undated compatibility row as existing", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(
        "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
      );
      db.$client
        .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
        .run("undated");
      const aligned = loadAlignedMigrationPlan(sourceFolders);
      expect(computeMigrationState(db.$client, aligned).existing).toBe(true);
    } finally {
      closeConnection(db);
    }
  });

  it("refuses a deleted legacy ledger row instead of recreating it", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(
          "DELETE FROM __bb_migration_ledger WHERE namespace = 'upstream' AND tag = '0008_thread_pinning'",
        )
        .run();
      expect(() => migrate(db)).toThrow(/Missing migration ledger rows/);
      expect(
        db.$client
          .prepare(
            "SELECT COUNT(*) AS count FROM __bb_migration_ledger WHERE tag = '0008_thread_pinning'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      closeConnection(db);
    }
  });

  it("refuses a deleted ledger table once a ledger has been written", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec("DELETE FROM __bb_migration_ledger");
      expect(() => migrate(db)).toThrow(MigrationStateUnknown);
    } finally {
      closeConnection(db);
    }
  });

  it("refuses a compatibility row this binary does not know", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        )
        .run("unknown-newer-step", Date.now() + 86_400_000);
      expect(() => migrate(db)).toThrow(/newer than this binary/);
    } finally {
      closeConnection(db);
    }
  });

  it("refuses an unknown compatibility row on a legacy database without a ledger", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec("DROP TABLE __bb_migration_ledger");
      db.$client
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        )
        .run("unknown-newer-step", Date.now() + 86_400_000);
      expect(() => migrate(db)).toThrow(/newer than this binary/);
    } finally {
      closeConnection(db);
    }
  });

  it("refuses a deleted ledger row of an applied step beyond the legacy chain", () => {
    const alephFolder = mkdtempSync(join(tmpdir(), "bb-runner-aleph-"));
    tempDirs.push(alephFolder);
    cpSync(sourceFolders.alephFolder, alephFolder, { recursive: true });
    const manifestPath = join(alephFolder, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      steps: Array<{
        id: string;
        file: string;
        after: string;
        when: number;
        supersedes?: string;
      }>;
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
    writeFileSync(
      join(alephFolder, "A0010_synthetic.sql"),
      "UPDATE app_settings SET updated_at = updated_at;",
    );
    const aligned = loadAlignedMigrationPlan({
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder,
    });
    const step = aligned.plan.steps.find(
      (candidate) => candidate.id === "A0010",
    );
    if (step === undefined) throw new Error("A0010 is not planned");

    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(
          "INSERT INTO __bb_migration_ledger (namespace, tag, sha256, how, applied_at) VALUES ('aleph', 'A0010', ?, 'applied', 1)",
        )
        .run(step.sha256);
      db.$client
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        )
        .run(step.sha256, Date.now() + 1000);
      expect(computeMigrationState(db.$client, aligned).pending).toEqual([]);
      db.$client
        .prepare("DELETE FROM __bb_migration_ledger WHERE tag = 'A0010'")
        .run();
      expect(() => computeMigrationState(db.$client, aligned)).toThrow(
        /Missing migration ledger rows: aleph:A0010/,
      );
    } finally {
      closeConnection(db);
    }
  });
});

describe("accepted legacy hash alternates", () => {
  const alternate = legacyMigrationChain.find(
    (entry) => entry.compatibleHashes.length > 0,
  );

  it("records the matched alternate and accepts it on later opens", () => {
    if (alternate === undefined) throw new Error("No alternate hash entry");
    const alternateHash = alternate.compatibleHashes[0];
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec("DROP TABLE __bb_migration_ledger");
      db.$client
        .prepare(
          "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?",
        )
        .run(alternateHash, alternate.when);
      migrate(db);
      expect(
        db.$client
          .prepare("SELECT sha256 FROM __bb_migration_ledger WHERE tag = ?")
          .get(alternate.tag),
      ).toEqual({ sha256: alternateHash });
      expect(() => migrate(db)).not.toThrow();
    } finally {
      closeConnection(db);
    }
  });
});

function fingerprint(db: DbConnection): string {
  return createHash("sha256").update(db.$client.serialize()).digest("hex");
}

function foreignKeys(db: DbConnection): unknown {
  return db.$client.pragma("foreign_keys", { simple: true });
}

function candidateFolders(tag: string, sql: string) {
  return {
    upstreamFolder: upstreamFolderWithCandidate(tag, sql),
    alephFolder: sourceFolders.alephFolder,
  };
}

describe("migrate refusals leave the database untouched", () => {
  it("refuses a tampered ledger hash and changes nothing", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(
          "UPDATE __bb_migration_ledger SET sha256 = 'tampered' WHERE namespace = 'upstream' AND tag = '0008_thread_pinning'",
        )
        .run();
      const before = fingerprint(db);
      expect(() => migrate(db)).toThrow(/ledger hash drift/);
      expect(fingerprint(db)).toBe(before);
      expect(foreignKeys(db)).toBe(1);
    } finally {
      closeConnection(db);
    }
  });

  it("refuses a ledger row from a foreign namespace", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(
          "INSERT INTO __bb_migration_ledger (namespace, tag, sha256, how, applied_at) VALUES ('other', 'X0001', 'abc', 'applied', 1)",
        )
        .run();
      const before = fingerprint(db);
      expect(() => migrate(db)).toThrow(/does not know/);
      expect(fingerprint(db)).toBe(before);
    } finally {
      closeConnection(db);
    }
  });

  it("runs the guard before any write", () => {
    const db = createConnection(":memory:");
    try {
      const before = fingerprint(db);
      expect(() =>
        migrateWithFolders(
          db,
          candidateFolders(
            "0144_synthetic",
            "DROP TABLE IF EXISTS aleph_install_requests;",
          ),
        ),
      ).toThrow(/0144_synthetic.*aleph_install_requests/);
      expect(fingerprint(db)).toBe(before);
    } finally {
      closeConnection(db);
    }
  });
});

describe("migrate step execution", () => {
  it("restores foreign keys after success", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      expect(foreignKeys(db)).toBe(1);
    } finally {
      closeConnection(db);
    }
  });

  it("rolls back the step, its ledger row and its compat row when a statement fails", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const before = fingerprint(db);
      expect(() =>
        migrateWithFolders(
          db,
          candidateFolders(
            "0144_synthetic",
            "CREATE TABLE zz_probe (x integer);\n--> statement-breakpoint\nINSERT INTO zz_missing (x) VALUES (1);",
          ),
        ),
      ).toThrow(/zz_missing/);
      expect(fingerprint(db)).toBe(before);
      expect(foreignKeys(db)).toBe(1);
      expect(db.$client.inTransaction).toBe(false);
    } finally {
      closeConnection(db);
    }
  });
});

describe("migrate classification", () => {
  it("records every plan step in the ledger on a fresh database", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const { plan } = loadAlignedMigrationPlan(sourceFolders);
      const rows = db.$client
        .prepare("SELECT namespace, tag FROM __bb_migration_ledger")
        .all() as Array<{ namespace: string; tag: string }>;
      for (const step of plan.steps) {
        expect(rows).toContainEqual({
          namespace: step.namespace,
          tag: step.id,
        });
      }
      expect(migrate(db)).toBeUndefined();
    } finally {
      closeConnection(db);
    }
  });

  it("matches the legacy runner's schema from every unpopulated legacy prefix", async () => {
    const schemaOf = (db: DbConnection): string[] =>
      (
        db.$client
          .prepare(
            "SELECT type || '|' || name || '|' || COALESCE(sql, '') AS line FROM sqlite_master WHERE name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
          )
          .all() as Array<{ line: string }>
      ).map((row) => row.line);
    const stepCount = loadAlignedMigrationPlan(sourceFolders).plan.steps.length;
    const mismatches: number[] = [];
    const legacyRefused: number[] = [];
    for (let length = 1; length <= legacyMigrationChain.length; length += 1) {
      const oracle = await openLegacyConnection();
      let expected: string[] | undefined;
      try {
        applyPrefix(oracle.$client, length);
        await legacyMigrate(oracle);
        expected = schemaOf(oracle);
      } catch {
        legacyRefused.push(length);
      } finally {
        closeConnection(oracle);
      }
      const db = createConnection(":memory:");
      try {
        applyPrefix(db.$client, length);
        migrate(db);
        const ledgerCount = db.$client
          .prepare("SELECT COUNT(*) AS n FROM __bb_migration_ledger")
          .get() as { n: number };
        if (ledgerCount.n < stepCount) mismatches.push(length);
        if (
          expected !== undefined &&
          JSON.stringify(schemaOf(db)) !== JSON.stringify(expected)
        )
          mismatches.push(length);
      } finally {
        closeConnection(db);
      }
    }
    expect(legacyRefused).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(mismatches).toEqual([]);
  }, 600_000);
});

describe("populated partial-deferred prefixes", () => {
  it.each([15, 16, 17, 18, 19])(
    "matches the legacy runner's schema and row counts from populated prefix %i",
    async (length) => {
      const snapshot = (db: DbConnection) => {
        const sqlite = db.$client;
        const tables = (
          sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '%\\_fts%' ESCAPE '\\' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => ({
          name: row.name,
          count: (
            sqlite.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get() as {
              n: number;
            }
          ).n,
        }));
        const schema = sqlite
          .prepare(
            "SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
          )
          .all();
        return { tables, schema };
      };
      const oracle = await populatedPrefixDatabase(length);
      let expected: ReturnType<typeof snapshot> | undefined;
      try {
        await legacyMigrate(oracle);
        expected = snapshot(oracle);
      } catch {
        expected = undefined;
      } finally {
        closeConnection(oracle);
      }
      const subject = await populatedPrefixDatabase(length);
      try {
        migrate(subject);
        if (expected !== undefined) expect(snapshot(subject)).toEqual(expected);
      } finally {
        closeConnection(subject);
      }
    },
    120_000,
  );
});

function alephFolderWithSteps(
  extra: ReadonlyArray<{ id: string; sql: string }>,
): string {
  const alephFolder = mkdtempSync(join(tmpdir(), "bb-runner-aleph-"));
  tempDirs.push(alephFolder);
  cpSync(sourceFolders.alephFolder, alephFolder, { recursive: true });
  const manifestPath = join(alephFolder, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    steps: Array<{ id: string; file: string; after: string; when: number }>;
  };
  for (const step of extra) {
    const last = manifest.steps[manifest.steps.length - 1];
    if (last === undefined) throw new Error("Manifest is empty");
    manifest.steps.push({
      id: step.id,
      file: `${step.id}_synthetic.sql`,
      after: last.id,
      when: last.when + 1000,
    });
    writeFileSync(join(alephFolder, `${step.id}_synthetic.sql`), step.sql);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return alephFolder;
}

describe("guard models with candidate upstream steps", () => {
  const createSource =
    "CREATE TABLE zz_source (id TEXT PRIMARY KEY);\n--> statement-breakpoint\nALTER TABLE zz_source ADD COLUMN extra TEXT;";

  it("accepts an Aleph step that builds on a candidate-created table", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "CREATE INDEX zz_source_idx ON zz_source (id);" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidate(
      "0144_zz_source",
      createSource,
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).not.toThrow();
  });

  it("allows a candidate to create and alter its own table", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "SELECT 1;" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidate(
      "0144_zz_source",
      createSource,
      alephFolder,
    );
    const db = createConnection(":memory:");
    try {
      migrateWithFolders(db, { upstreamFolder, alephFolder });
      expect(
        db.$client
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'zz_source'")
          .get(),
      ).toBeDefined();
    } finally {
      closeConnection(db);
    }
  });

  it("still refuses a candidate that alters a table the Aleph steps alter", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "SELECT 1;" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidate(
      "0144_zz_threads",
      "ALTER TABLE threads ADD COLUMN zz_extra TEXT;",
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(/0144_zz_threads.*threads/);
  });
});

describe("compat log identity handling", () => {
  it("does not treat a new step with identical SQL as already applied", () => {
    const sql = "UPDATE app_settings SET updated_at = updated_at;";
    const folders = (ids: string[]) => ({
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder: alephFolderWithSteps(ids.map((id) => ({ id, sql }))),
    });
    const db = createConnection(":memory:");
    try {
      migrateWithFolders(db, folders(["A0010"]));
      expect(() =>
        migrateWithFolders(db, folders(["A0010", "A0011"])),
      ).not.toThrow();
      const rows = db.$client
        .prepare(
          "SELECT tag FROM __bb_migration_ledger WHERE namespace = 'aleph' AND tag IN ('A0010', 'A0011') ORDER BY tag",
        )
        .all();
      expect(rows).toEqual([{ tag: "A0010" }, { tag: "A0011" }]);
    } finally {
      closeConnection(db);
    }
  });

  it("still refuses a deleted ledger row when identical-SQL steps both ran", () => {
    const sql = "UPDATE app_settings SET updated_at = updated_at;";
    const folders = {
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder: alephFolderWithSteps([
        { id: "A0010", sql },
        { id: "A0011", sql },
      ]),
    };
    const db = createConnection(":memory:");
    try {
      migrateWithFolders(db, folders);
      db.$client
        .prepare("DELETE FROM __bb_migration_ledger WHERE tag = 'A0011'")
        .run();
      expect(() => migrateWithFolders(db, folders)).toThrow(
        /Missing migration ledger rows: aleph:A0011/,
      );
    } finally {
      closeConnection(db);
    }
  });
});

describe("NULL created_at compatibility rows", () => {
  const canonical = legacyMigrationChain[0]?.sha256 ?? "";

  it.each([
    ["a stray hash", "stray"],
    ["a canonical hash", canonical],
  ])(
    "opens a complete legacy database with %s and NULL created_at like the legacy runner",
    async (_label, hash) => {
      const oracle = await openLegacyConnection();
      try {
        applyPrefix(oracle.$client, legacyMigrationChain.length);
        oracle.$client
          .prepare(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, NULL)",
          )
          .run(hash);
        await legacyMigrate(oracle);
      } finally {
        closeConnection(oracle);
      }
      const db = createConnection(":memory:");
      try {
        applyPrefix(db.$client, legacyMigrationChain.length);
        db.$client
          .prepare(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, NULL)",
          )
          .run(hash);
        expect(() => migrate(db)).not.toThrow();
        expect(() => migrate(db)).not.toThrow();
      } finally {
        closeConnection(db);
      }
    },
  );
});

function upstreamFolderWithCandidates(
  candidates: ReadonlyArray<{ tag: string; sql: string }>,
  alephFolder: string,
): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-runner-upstream-"));
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

describe("skipped Aleph statements keep their trusted tables protected", () => {
  it.each([
    [
      "app_settings",
      "ADD COLUMN zz_extra TEXT",
      "CREATE INDEX zz_idx ON app_settings (zz_extra);",
      "DROP TABLE app_settings;",
    ],
    [
      "hosts",
      "ADD COLUMN zz_extra TEXT",
      "CREATE INDEX zz_idx ON hosts (zz_extra);",
      "ALTER TABLE hosts ADD COLUMN zz_other TEXT;",
    ],
  ])(
    "refuses the candidate that alters %s once a skipped Aleph index references it",
    (table, add, index, later) => {
      const alephFolder = alephFolderWithSteps([{ id: "A0010", sql: index }]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          { tag: "0144_zz_alter", sql: `ALTER TABLE ${table} ${add};` },
          { tag: "0145_zz_later", sql: later },
        ],
        alephFolder,
      );
      const db = createConnection(":memory:");
      try {
        migrate(db);
        const before = fingerprint(db);
        expect(() =>
          migrateWithFolders(db, { upstreamFolder, alephFolder }),
        ).toThrow(new RegExp(`0144_zz_alter.*${table}`));
        expect(fingerprint(db)).toBe(before);
      } finally {
        closeConnection(db);
      }
    },
  );

  it.each([
    ["with IF EXISTS", "DROP INDEX IF EXISTS zz_idx;"],
    ["without IF EXISTS", "DROP INDEX zz_idx;"],
  ])(
    "keeps the owner of a candidate index guarded when an Aleph step drops it %s",
    (_label, drop) => {
      const alephFolder = alephFolderWithSteps([{ id: "A0010", sql: drop }]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          {
            tag: "0144_zz_index",
            sql: "CREATE INDEX zz_idx ON app_settings (updated_at);",
          },
          { tag: "0145_zz_drop", sql: "DROP TABLE app_settings;" },
        ],
        alephFolder,
      );
      expect(() =>
        loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
      ).toThrow(/0145_zz_drop.*app_settings/);
    },
  );

  it("keeps the owner of a candidate trigger guarded when an Aleph step drops it", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "DROP TRIGGER zz_trigger;" },
    ]);
    const trigger =
      "CREATE TRIGGER zz_trigger AFTER INSERT ON app_settings BEGIN SELECT 1; END;";
    expect(() =>
      loadAlignedMigrationPlan({
        upstreamFolder: upstreamFolderWithCandidates(
          [{ tag: "0144_zz_trigger", sql: trigger }],
          alephFolder,
        ),
        alephFolder,
      }),
    ).not.toThrow();
    expect(() =>
      loadAlignedMigrationPlan({
        upstreamFolder: upstreamFolderWithCandidates(
          [
            { tag: "0144_zz_trigger", sql: trigger },
            {
              tag: "0145_zz_alter",
              sql: "ALTER TABLE app_settings ADD COLUMN zz_extra TEXT;",
            },
          ],
          alephFolder,
        ),
        alephFolder,
      }),
    ).toThrow(/0145_zz_alter.*app_settings/);
  });

  it.each([
    [
      "an IS DISTINCT FROM operand",
      "INSERT INTO zz_source (value) SELECT 'x' WHERE 'y' IS DISTINCT FROM 'app_settings';",
    ],
    [
      "a join predicate",
      "INSERT INTO zz_source (value) SELECT 'x' FROM zz_source AS a JOIN zz_source AS b ON 'app_settings' = 'app_settings';",
    ],
  ])(
    "does not guard a table named only by a string literal in %s",
    (_label, statement) => {
      const alephFolder = alephFolderWithSteps([
        { id: "A0010", sql: statement },
      ]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          {
            tag: "0144_zz_source",
            sql: "CREATE TABLE zz_source (value TEXT);",
          },
          {
            tag: "0145_zz_alter",
            sql: "ALTER TABLE app_settings ADD COLUMN zz_extra TEXT;",
          },
        ],
        alephFolder,
      );
      expect(() =>
        loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
      ).not.toThrow();
    },
  );

  it.each([
    [
      "an UPDATE OR REPLACE target",
      "UPDATE OR REPLACE 'app_settings' SET missing_col = 1 WHERE id IN (SELECT id FROM zz_noop);",
    ],
    [
      "a comma-joined FROM item",
      "INSERT INTO zz_noop (id) SELECT missing_col FROM hosts, 'app_settings';",
    ],
  ])(
    "guards a table named as %s in a skipped Aleph statement",
    (_label, statement) => {
      const alephFolder = alephFolderWithSteps([
        { id: "A0010", sql: statement },
      ]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          { tag: "0144_zz_noop", sql: "CREATE TABLE zz_noop (id TEXT);" },
          {
            tag: "0145_zz_alter",
            sql: "ALTER TABLE app_settings ADD COLUMN zz_extra TEXT;",
          },
        ],
        alephFolder,
      );
      expect(() =>
        loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
      ).toThrow(/0145_zz_alter.*app_settings/);
    },
  );

  it.each([
    [
      "a parenthesised join",
      "INSERT INTO zz_source (value) SELECT a.value FROM (zz_source AS a, 'app_settings' AS b);",
    ],
    [
      "a nested parenthesised FROM item",
      "INSERT INTO zz_source (value) SELECT a.value FROM zz_source AS a, (('app_settings'));",
    ],
    [
      "a parenthesised join without aliases",
      "INSERT INTO zz_source (value) SELECT missing FROM (zz_source, 'app_settings');",
    ],
    ["an IN target", "DELETE FROM zz_source WHERE missing IN 'app_settings';"],
  ])(
    "guards a table named as %s in a skipped Aleph statement",
    (_label, statement) => {
      const alephFolder = alephFolderWithSteps([
        { id: "A0010", sql: statement },
      ]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          {
            tag: "0144_zz_source",
            sql: "CREATE TABLE zz_source (value TEXT);",
          },
          { tag: "0145_zz_drop", sql: "DROP TABLE app_settings;" },
        ],
        alephFolder,
      );
      expect(() =>
        loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
      ).toThrow(/0145_zz_drop.*app_settings/);
    },
  );

  it.each([
    "DELETE FROM zz_source WHERE value IN (SELECT 1 FROM zz_source, 'app_settings');",
    "DELETE FROM zz_source WHERE value IN (SELECT hosts.id FROM hosts, 'app_settings');",
    "DELETE FROM zz_source WHERE EXISTS (SELECT 1 FROM zz_source,'app_settings');",
    "DELETE FROM zz_source WHERE value = lower((SELECT 1 FROM zz_source, 'app_settings'));",
    "INSERT INTO zz_source VALUES ((SELECT 1 FROM zz_source, 'app_settings'));",
    "DELETE FROM zz_source WHERE value IN (WITH q AS (SELECT 1) SELECT 1 FROM q, 'app_settings');",
  ])("guards a table named inside a nested subquery: %s", (statement) => {
    const alephFolder = alephFolderWithSteps([{ id: "A0010", sql: statement }]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        { tag: "0144_zz_source", sql: "CREATE TABLE zz_source (value TEXT);" },
        { tag: "0145_zz_drop", sql: "DROP TABLE app_settings;" },
      ],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(/0145_zz_drop.*app_settings/);
  });

  it.each([
    "DELETE FROM zz_source WHERE value IN (VALUES (1) UNION SELECT 1 FROM zz_source, 'app_settings');",
    "DELETE FROM zz_source WHERE EXISTS (VALUES (1) UNION SELECT 1 FROM zz_source, 'app_settings');",
    "DELETE FROM zz_source WHERE value = lower((VALUES (1) UNION SELECT 1 FROM zz_source, 'app_settings'));",
    "INSERT INTO zz_source VALUES ((VALUES (1) UNION SELECT 1 FROM zz_source, 'app_settings'));",
  ])(
    "guards a table named after a compound select in a values list: %s",
    (statement) => {
      const alephFolder = alephFolderWithSteps([
        { id: "A0010", sql: statement },
      ]);
      const upstreamFolder = upstreamFolderWithCandidates(
        [
          {
            tag: "0144_zz_source",
            sql: "CREATE TABLE zz_source (value TEXT);",
          },
          { tag: "0145_zz_drop", sql: "DROP TABLE app_settings;" },
        ],
        alephFolder,
      );
      expect(() =>
        loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
      ).toThrow(/0145_zz_drop.*app_settings/);
    },
  );

  it("does not guard a table named only inside literal lists", () => {
    const alephFolder = alephFolderWithSteps([
      {
        id: "A0010",
        sql: "INSERT INTO zz_source (value) SELECT 'x' WHERE 'x' IN ('app_settings', 'y') OR lower('app_settings') = 'z';",
      },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        { tag: "0144_zz_source", sql: "CREATE TABLE zz_source (value TEXT);" },
        {
          tag: "0145_zz_alter",
          sql: "ALTER TABLE app_settings ADD COLUMN zz_extra TEXT;",
        },
      ],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).not.toThrow();
  });

  const loadWithStatement = (statement: string) => {
    const alephFolder = alephFolderWithSteps([{ id: "A0010", sql: statement }]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        { tag: "0144_zz_source", sql: "CREATE TABLE zz_source (value TEXT);" },
        {
          tag: "0145_zz_alter",
          sql: "ALTER TABLE app_settings ADD COLUMN zz_extra TEXT;",
        },
      ],
      alephFolder,
    );
    return () => loadAlignedMigrationPlan({ upstreamFolder, alephFolder });
  };

  it.each([
    "INSERT INTO zz_source VALUES ('a'), ('app_settings');",
    "INSERT INTO zz_source SELECT 1 WHERE 'x' IN (VALUES ('x'), ('app_settings'));",
    "WITH v(x) AS (VALUES ('a'), ('app_settings')) INSERT INTO zz_source SELECT x FROM v;",
  ])("does not guard a literal in a later VALUES row: %s", (statement) => {
    expect(loadWithStatement(statement)).not.toThrow();
  });

  it("still guards a subquery in a later VALUES row", () => {
    expect(
      loadWithStatement(
        "INSERT INTO zz_source VALUES (1), ((SELECT 1 FROM zz_source, 'app_settings'));",
      ),
    ).toThrow(/0145_zz_alter.*app_settings/);
  });

  it("classifies a statement behind a CTE named like a verb", () => {
    expect(statementVerb("WITH begin AS (SELECT 1) DELETE FROM zz_ghost")).toBe(
      "delete",
    );
    expect(
      statementVerb(
        "WITH RECURSIVE a(x) AS (SELECT 1), b AS (SELECT 2) UPDATE t SET x = 1",
      ),
    ).toBe("update");
  });

  it("wraps an unexpected candidate statement failure as a guard error", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "CREATE TABLE zz_aleph (id TEXT);" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [{ tag: "0144_zz_broken", sql: "CREATE TABLE zz_broken (" }],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(MigrationGuardError);
  });

  it("refuses a skipped statement behind a CTE that targets no known object", () => {
    const alephFolder = alephFolderWithSteps([
      {
        id: "A0010",
        sql: "WITH x AS (SELECT 1) DELETE FROM zz_ghost WHERE id IN (SELECT * FROM x);",
      },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [{ tag: "0144_zz_other", sql: "CREATE TABLE zz_other (id TEXT);" }],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).toThrow(/targets no known table/);
  });

  it("keeps the real plan at 25 guarded tables when a candidate only adds a table", () => {
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        {
          tag: "0144_zz_new",
          sql: "CREATE TABLE zz_new (id TEXT PRIMARY KEY);",
        },
      ],
      sourceFolders.alephFolder,
    );
    const aligned = loadAlignedMigrationPlan({
      upstreamFolder,
      alephFolder: sourceFolders.alephFolder,
    });
    expect(aligned.guardedTables).toHaveLength(25);
  });

  it("still tolerates a skipped Aleph statement on a candidate-created table", () => {
    const alephFolder = alephFolderWithSteps([
      { id: "A0010", sql: "CREATE INDEX zz_source_idx ON zz_source (id);" },
    ]);
    const upstreamFolder = upstreamFolderWithCandidates(
      [
        {
          tag: "0144_zz_source",
          sql: "CREATE TABLE zz_source (id TEXT PRIMARY KEY);",
        },
        {
          tag: "0145_zz_source_more",
          sql: "ALTER TABLE zz_source ADD COLUMN extra TEXT;",
        },
      ],
      alephFolder,
    );
    expect(() =>
      loadAlignedMigrationPlan({ upstreamFolder, alephFolder }),
    ).not.toThrow();
  });
});

describe("compat log occurrence counting", () => {
  it("counts exact duplicate compat rows once", () => {
    const sql = "UPDATE app_settings SET updated_at = updated_at;";
    const folders = (ids: string[]) => ({
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder: alephFolderWithSteps(ids.map((id) => ({ id, sql }))),
    });
    const db = createConnection(":memory:");
    try {
      const first = folders(["A0010"]);
      migrateWithFolders(db, first);
      const hash = loadAlignedMigrationPlan(first).plan.steps.find(
        (step) => step.id === "A0010",
      )?.sha256;
      db.$client
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) SELECT hash, created_at FROM __drizzle_migrations WHERE hash = ?",
        )
        .run(hash);
      expect(() =>
        migrateWithFolders(db, folders(["A0010", "A0011"])),
      ).not.toThrow();
    } finally {
      closeConnection(db);
    }
  });
});

describe("compat log with only NULL created_at rows", () => {
  const createLog =
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)";

  it.each([0, 15, 16, 17, 18, 19])(
    "migrates prefix %i with a stray NULL row like the legacy runner",
    async (length) => {
      const seed = (sqlite: DbConnection["$client"]) => {
        if (length > 0) applyPrefix(sqlite, length);
        sqlite.exec(createLog);
        sqlite
          .prepare(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stray', NULL)",
          )
          .run();
      };
      const oracle = await openLegacyConnection();
      try {
        seed(oracle.$client);
        await expect(legacyMigrate(oracle)).resolves.not.toThrow();
      } finally {
        closeConnection(oracle);
      }
      const db = createConnection(":memory:");
      try {
        seed(db.$client);
        expect(() => migrate(db)).not.toThrow();
        expect(() => migrate(db)).not.toThrow();
      } finally {
        closeConnection(db);
      }
    },
  );
});
