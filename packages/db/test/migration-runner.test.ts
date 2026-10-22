import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import { migrateWithFolders } from "../src/migrate.js";
import { legacyMigrationChain } from "../src/legacy-migration-chain.js";
import { MigrationStateUnknown } from "../src/migration-ledger.js";
import {
  computeMigrationState,
  loadAlignedMigrationPlan,
} from "../src/migration-runner.js";
import { applyPrefix } from "./helpers/legacy-oracle.js";
import {
  legacyMigrate,
  openLegacyConnection,
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

function upstreamFolderWithCandidate(tag: string, sql: string): string {
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
        ...loadAlignedMigrationPlan(sourceFolders).plan.steps.map(
          (step) => step.when,
        ),
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
