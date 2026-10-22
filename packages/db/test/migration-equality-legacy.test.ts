import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyFolder,
  buildTruncatedFolder,
  LEGACY_ORACLE_COMMIT,
  UPSTREAM_ORACLE_COMMIT,
} from "./helpers/legacy-oracle.js";
import type { DbConnection } from "../src/connection.js";
import {
  combineRowHashes,
  contentOnly,
  describeDatabase,
  describeSchema,
  describeSequences,
  diffDescriptions,
  digestTable,
  rowHash,
  schemaFingerprint,
  type DatabaseDescription,
} from "./helpers/migration-equality.js";
import {
  EQUALITY_PREFIX_LENGTHS,
  GROUPED_PREFIX_LENGTHS,
  groupedPrefixDatabase,
  ledgerRows,
  legacyMigrate,
  pinMigrationClock,
  type PinnedCounts,
  populatedPrefixDatabase,
  populatedUpstreamDatabase,
} from "./helpers/migration-scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const referencePath = resolve(
  here,
  "fixtures",
  "legacy-migration-equality-reference.json",
);

interface ReferenceFile {
  legacyCommit: string;
  upstreamCommit: string;
  schemaFingerprint: string;
  prefixes: Record<string, ReferenceEntry>;
}

interface ReferenceEntry extends Omit<DatabaseDescription, "schema"> {
  pinned: PinnedCounts;
}

const scenarioPath = resolve(
  here,
  "fixtures",
  "legacy-ledger-scenarios-reference.json",
);

const TIMEOUT = 300_000;

interface ScenarioSnapshot {
  description: DatabaseDescription;
  ledger: ReturnType<typeof ledgerRows>;
  pinned: PinnedCounts;
}

function expectScenario(name: string, db: DbConnection): void {
  const pinned = pinMigrationClock(db.$client);
  const snapshot: ScenarioSnapshot = {
    description: describeDatabase(db.$client),
    ledger: ledgerRows(db.$client),
    pinned,
  };
  const stored: Record<string, ScenarioSnapshot> = existsSync(scenarioPath)
    ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as Record<
        string,
        ScenarioSnapshot
      >)
    : {};
  if (process.env.UPDATE_MIGRATION_EQUALITY_REFERENCE === "1") {
    if (process.env.CI)
      throw new Error(
        "UPDATE_MIGRATION_EQUALITY_REFERENCE must not be set in CI",
      );
    stored[name] = snapshot;
    writeFileSync(
      scenarioPath,
      `${JSON.stringify(Object.fromEntries(Object.entries(stored).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`,
    );
  }
  expect(snapshot).toEqual(stored[name]);
}

interface Upgraded {
  description: DatabaseDescription;
  pinned: PinnedCounts;
}

async function upgradeDatabase(db: DbConnection): Promise<Upgraded> {
  try {
    await legacyMigrate(db);
    const pinned = pinMigrationClock(db.$client);
    return { description: describeDatabase(db.$client), pinned };
  } finally {
    db.$client.close();
  }
}

async function upgradeFromPrefix(length: number): Promise<Upgraded> {
  return upgradeDatabase(await populatedPrefixDatabase(length));
}

async function upgradeGroupedPrefix(
  length: number,
): Promise<
  Upgraded & { flags: Record<string, number>; after: Record<string, number> }
> {
  const { db, flags } = await groupedPrefixDatabase(length);
  const sqlite = db.$client;
  await legacyMigrate(db);
  const after: Record<string, number> = {};
  for (const row of sqlite
    .prepare("SELECT id, group_with_next AS flag FROM queued_thread_messages")
    .all() as Array<{ id: string; flag: number }>)
    after[row.id] = row.flag;
  const pinned = pinMigrationClock(sqlite);
  const description = describeDatabase(sqlite);
  sqlite.close();
  return { description, pinned, flags, after };
}

describe("migration equality harness: digest primitives", () => {
  it("distinguishes values that differ only in how bytes are framed", () => {
    expect(rowHash(["aT", "b"])).not.toBe(rowHash(["a", "Tb"]));
    expect(rowHash(["1"])).not.toBe(rowHash([1n]));
    expect(rowHash([null])).not.toBe(rowHash([""]));
    expect(rowHash([Buffer.from("x")])).not.toBe(rowHash(["x"]));
  });

  it("keeps the original TEXT bytes, not their decoded form", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE a (v TEXT); CREATE TABLE b (v TEXT); INSERT INTO a VALUES (CAST(x'80' AS TEXT)); INSERT INTO b VALUES (CAST(x'81' AS TEXT));",
    );
    expect(digestTable(sqlite, "a")).not.toEqual(digestTable(sqlite, "b"));
    sqlite.exec(
      "CREATE TABLE c (v TEXT); INSERT INTO c VALUES ('ab'); CREATE TABLE d (v TEXT); INSERT INTO d VALUES (CAST(x'6162' AS TEXT));",
    );
    expect(digestTable(sqlite, "c")).toEqual(digestTable(sqlite, "d"));
    sqlite.close();
  });

  it("sees the ledger table definition", () => {
    const make = (hashColumn: string) => {
      const sqlite = new Database(":memory:");
      sqlite.exec(
        `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, ${hashColumn}, created_at numeric)`,
      );
      sqlite.exec("INSERT INTO __drizzle_migrations (hash) VALUES ('h')");
      const description = describeDatabase(sqlite);
      sqlite.close();
      return description;
    };
    const strict = make("hash text NOT NULL");
    const loose = make("hash text");
    expect(strict.ledger).toEqual(loose.ledger);
    expect(strict.ledgerSchema).not.toEqual(loose.ledgerSchema);
    expect(strict).not.toEqual(loose);
  });

  it("keeps INTEGER and REAL values apart, including integral reals", () => {
    expect(rowHash([1])).not.toBe(rowHash([1n]));
    expect(rowHash([1.5])).not.toBe(rowHash([1n]));
    expect(rowHash([2 ** 53])).not.toBe(rowHash([BigInt(2 ** 53)]));
    expect(() => rowHash([1n << 63n])).toThrow(/64-bit/);
    expect(() => rowHash([-(1n << 63n) - 1n])).toThrow(/64-bit/);
    expect(rowHash([(1n << 63n) - 1n])).toBeTypeOf("bigint");
  });

  it("is order-insensitive but counts duplicate rows", () => {
    const a = rowHash(["a"]);
    const b = rowHash(["b"]);
    expect(combineRowHashes([a, b])).toEqual(combineRowHashes([b, a]));
    expect(combineRowHashes([a, a])).not.toEqual(combineRowHashes([]));
    expect(combineRowHashes([a, a, b])).not.toEqual(combineRowHashes([b]));
    expect(combineRowHashes([a, a]).count).toBe(2);
  });

  it("keeps whitespace inside quoted literals when comparing schema SQL", () => {
    const describe = (literal: string, gap: string) => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`CREATE TABLE t (a${gap}text DEFAULT '${literal}')`);
      const lines = describeSchema(sqlite);
      sqlite.close();
      return lines;
    };
    expect(describe("x  y", " ")).not.toEqual(describe("x y", " "));
    expect(describe("x y", " ")).toEqual(describe("x y", "\n  "));
  });

  it("rejects duplicate sqlite_sequence rows and orders the rest", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO b DEFAULT VALUES; INSERT INTO a DEFAULT VALUES;",
    );
    expect(describeSequences(sqlite)).toEqual([
      ["a", "1"],
      ["b", "1"],
    ]);
    sqlite.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('a', 9)");
    expect(() => describeSequences(sqlite)).toThrow(
      /Duplicate sqlite_sequence/,
    );
    sqlite.close();
  });
});

describe("migration equality harness: legacy runner as oracle", () => {
  it(
    "builds identical populated descriptions twice and detects mutations",
    async () => {
      const first = await populatedPrefixDatabase(152);
      const second = await populatedPrefixDatabase(152);
      const left = describeDatabase(first.$client);
      expect(describeDatabase(second.$client)).toEqual(left);
      expect(
        diffDescriptions(
          contentOnly(left),
          contentOnly(describeDatabase(second.$client)),
        ),
      ).toEqual([]);

      second.$client.exec(
        "UPDATE projects SET name = name || 'x' WHERE rowid = 1",
      );
      expect(
        diffDescriptions(
          contentOnly(left),
          contentOnly(describeDatabase(second.$client)),
        ),
      ).toEqual([expect.stringContaining("table differs: projects")]);

      second.$client.exec("CREATE INDEX harness_probe_idx ON projects (name)");
      expect(
        diffDescriptions(
          contentOnly(left),
          contentOnly(describeDatabase(second.$client)),
        ).some((line) => line.startsWith("schema extra")),
      ).toBe(true);
      first.$client.close();
      second.$client.close();
    },
    TIMEOUT,
  );

  it(
    "detects renumbered rowids, swapped duplicate-text rows, relinked FTS rows, a changed counter and pragma drift",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const sqlite = db.$client;
      const base = contentOnly(describeDatabase(sqlite));
      const changed = () =>
        diffDescriptions(base, contentOnly(describeDatabase(sqlite)));

      const top = (
        sqlite
          .prepare("SELECT MAX(rowid) AS top FROM thread_search_segments")
          .get() as { top: number }
      ).top;
      sqlite.exec(
        `UPDATE thread_search_segments SET rowid = ${top + 1000} WHERE rowid = ${top}`,
      );
      expect(changed()).toEqual([
        expect.stringContaining("table differs: thread_search_segments"),
      ]);
      sqlite.exec(
        `UPDATE thread_search_segments SET rowid = ${top} WHERE rowid = ${top + 1000}`,
      );
      expect(changed()).toEqual([]);

      const duplicated = sqlite
        .prepare(
          "SELECT rowid FROM thread_search_segments WHERE text = 'duplicated search text' ORDER BY rowid",
        )
        .all() as Array<{ rowid: number }>;
      expect(duplicated).toHaveLength(2);
      const [first, second] = duplicated;
      sqlite.exec(
        `UPDATE thread_search_segments SET rowid = -1 WHERE rowid = ${first?.rowid}; UPDATE thread_search_segments SET rowid = ${first?.rowid} WHERE rowid = ${second?.rowid}; UPDATE thread_search_segments SET rowid = ${second?.rowid} WHERE rowid = -1`,
      );
      expect(changed()).toEqual([
        expect.stringContaining("table differs: thread_search_segments"),
      ]);
      sqlite.exec(
        `UPDATE thread_search_segments SET rowid = -1 WHERE rowid = ${first?.rowid}; UPDATE thread_search_segments SET rowid = ${first?.rowid} WHERE rowid = ${second?.rowid}; UPDATE thread_search_segments SET rowid = ${second?.rowid} WHERE rowid = -1`,
      );
      expect(changed()).toEqual([]);

      sqlite.exec(
        `UPDATE thread_search_segments_fts SET rowid = 9999 WHERE rowid = ${first?.rowid}`,
      );
      expect(changed()).toEqual([
        expect.stringContaining("table differs: thread_search_segments_fts"),
      ]);
      sqlite.exec(
        `UPDATE thread_search_segments_fts SET rowid = ${first?.rowid} WHERE rowid = 9999`,
      );
      expect(changed()).toEqual([]);

      sqlite.exec(
        "UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'transfer_events'",
      );
      expect(changed()).toEqual(["sqlite_sequence state differs"]);
      sqlite.exec(
        "UPDATE sqlite_sequence SET seq = seq - 1 WHERE name = 'transfer_events'",
      );

      sqlite.pragma("user_version = 7");
      expect(changed()).toEqual([expect.stringContaining("pragmas differ")]);
      sqlite.pragma("user_version = 0");
      expect(changed()).toEqual([]);
      sqlite.close();
    },
    TIMEOUT,
  );

  it(
    "upgrades every populated prefix to the pinned reference state",
    async () => {
      const results: Record<string, Upgraded> = {};
      for (const length of EQUALITY_PREFIX_LENGTHS)
        results[String(length)] = await upgradeFromPrefix(length);
      for (const length of GROUPED_PREFIX_LENGTHS) {
        const { description, pinned } = await upgradeGroupedPrefix(length);
        results[`grouped-${length}`] = { description, pinned };
      }

      const fingerprints = new Set(
        Object.values(results).map(({ description }) =>
          schemaFingerprint(description),
        ),
      );
      expect(fingerprints.size).toBe(1);

      const current: ReferenceFile = {
        legacyCommit: LEGACY_ORACLE_COMMIT,
        upstreamCommit: UPSTREAM_ORACLE_COMMIT,
        schemaFingerprint: [...fingerprints][0] ?? "",
        prefixes: Object.fromEntries(
          Object.entries(results).map(([key, { description, pinned }]) => [
            key,
            {
              pragmas: description.pragmas,
              sequences: description.sequences,
              tables: description.tables,
              ledger: description.ledger,
              ledgerSchema: description.ledgerSchema,
              pinned,
            },
          ]),
        ),
      };
      if (process.env.UPDATE_MIGRATION_EQUALITY_REFERENCE === "1") {
        if (process.env.CI)
          throw new Error(
            "UPDATE_MIGRATION_EQUALITY_REFERENCE must not be set in CI",
          );
        writeFileSync(referencePath, `${JSON.stringify(current, null, 2)}\n`);
      }
      const reference = JSON.parse(
        readFileSync(referencePath, "utf8"),
      ) as ReferenceFile;
      expect(current).toEqual(reference);
    },
    TIMEOUT,
  );

  it(
    "restores group_with_next through the staging table for every grouped prefix",
    async () => {
      for (const length of GROUPED_PREFIX_LENGTHS) {
        const { flags, after } = await upgradeGroupedPrefix(length);
        expect(
          Object.values(flags).filter((flag) => flag === 1).length,
        ).toBeGreaterThan(0);
        expect(
          Object.values(flags).filter((flag) => flag === 0).length,
        ).toBeGreaterThan(0);
        expect(after, `prefix ${length}`).toEqual(flags);
      }
    },
    TIMEOUT,
  );

  it(
    "stages group_with_next before migration 0004 rebuilds queued_thread_messages",
    async () => {
      const columnPresent = (sqlite: Database.Database): boolean =>
        sqlite
          .prepare(
            "SELECT 1 FROM pragma_table_info('queued_thread_messages') WHERE name = 'group_with_next'",
          )
          .get() !== undefined;
      const { db: twin, flags } = await groupedPrefixDatabase(4);
      expect(columnPresent(twin.$client)).toBe(true);
      const folder = buildTruncatedFolder(5);
      try {
        applyFolder(twin.$client, folder);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
      expect(columnPresent(twin.$client)).toBe(false);
      twin.$client.close();

      const { db } = await groupedPrefixDatabase(4);
      await expect(legacyMigrate(db)).rejects.toThrow(/DROP INDEX/);
      const staged: Record<string, number> = {};
      for (const row of db.$client
        .prepare(
          "SELECT id, group_with_next AS flag FROM temp.bb_migration_queued_message_groups",
        )
        .all() as Array<{ id: string; flag: number }>)
        staged[row.id] = row.flag;
      expect(Object.keys(flags).length).toBeGreaterThan(1);
      expect(staged).toEqual(flags);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "keeps an existing onboarding stamp and restamps a null one (migration 0148)",
    async () => {
      const kept = await populatedPrefixDatabase(147);
      kept.$client
        .prepare(
          "INSERT INTO app_settings_values (key, value, updated_at) VALUES ('onboardingCompletedAt', ?, 5)",
        )
        .run(JSON.stringify("2020-01-01T00:00:00.000Z"));
      await legacyMigrate(kept);
      expect(
        kept.$client
          .prepare(
            "SELECT value, updated_at FROM app_settings_values WHERE key = 'onboardingCompletedAt'",
          )
          .get(),
      ).toEqual({ value: '"2020-01-01T00:00:00.000Z"', updated_at: 5 });
      expect(pinMigrationClock(kept.$client).onboardingCompletedAtValue).toBe(
        0,
      );
      kept.$client.close();

      const nulled = await populatedPrefixDatabase(147);
      nulled.$client
        .prepare(
          "INSERT INTO app_settings_values (key, value, updated_at) VALUES ('onboardingCompletedAt', 'null', 5)",
        )
        .run();
      await legacyMigrate(nulled);
      const pinned = pinMigrationClock(nulled.$client);
      expect(pinned.onboardingCompletedAtValue).toBe(1);
      expect(pinned.updatedAt.app_settings_values).toBe(1);
      nulled.$client.close();
    },
    TIMEOUT,
  );
});

describe("legacy runner behaviour on ledger shapes (S3 rows 8, 16, 18, 20, 21)", () => {
  it(
    "row 16: an exact duplicate ledger row is tolerated and changes nothing",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid DESC LIMIT 1",
      );
      await legacyMigrate(db);
      const after = describeDatabase(db.$client);
      expect(diffDescriptions(contentOnly(before), contentOnly(after))).toEqual(
        [],
      );
      const rows = ledgerRows(db.$client);
      expect(rows).toHaveLength(153);
      expect(rows[151]).toMatchObject({
        hash: rows[152]?.hash,
        created_at: rows[152]?.created_at,
      });
      expectScenario("row16-exact-duplicate", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: a stray NULL row with an unknown hash beside complete rows is ignored",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stray', NULL)",
      );
      await legacyMigrate(db);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([]);
      const rows = ledgerRows(db.$client);
      expect(rows).toHaveLength(153);
      expect(rows.filter((row) => row.created_at === null)).toHaveLength(1);
      expectScenario("row8-stray-null", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: a NULL row carrying a canonical step hash beside the complete row is ignored",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) SELECT hash, NULL FROM __drizzle_migrations WHERE rowid = (SELECT MAX(rowid) - 7 FROM __drizzle_migrations)",
      );
      await legacyMigrate(db);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([]);
      const rows = ledgerRows(db.$client);
      expect(rows).toHaveLength(153);
      expect(rows.filter((row) => row.created_at === null)).toHaveLength(1);
      expectScenario("row8-canonical-hash-null", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 18: an unrecognised row with a past created_at is accepted and changes nothing",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('unknown-dev-branch-hash', 1790298785171)",
      );
      await legacyMigrate(db);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([]);
      expect(ledgerRows(db.$client)).toHaveLength(153);
      expectScenario("row18-unknown-past", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 9 and 18: an unrecognised row with a future created_at is accepted and warns once",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('unknown-future-hash', 4102444800000)",
      );
      const warnings: Array<{ message: string; migrations: unknown }> = [];
      await legacyMigrate(db, {
        logger: {
          warn: (fields, message) =>
            warnings.push({ message, migrations: fields.migrations }),
        },
      });
      expect(warnings).toEqual([
        {
          message: "Applied database migrations have future timestamps",
          migrations: [
            { hash: "unknown-future-hash", createdAt: 4102444800000 },
          ],
        },
      ]);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([]);
      expect(ledgerRows(db.$client)).toHaveLength(153);
      expectScenario("row18-unknown-future", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: a NULL created_at on a mid-chain step refuses as missing-created-at and leaves the database unchanged",
    async () => {
      const db = await populatedPrefixDatabase(152);
      db.$client.exec(
        "UPDATE __drizzle_migrations SET created_at = NULL WHERE rowid = (SELECT MAX(rowid) - 5 FROM __drizzle_migrations)",
      );
      const before = describeDatabase(db.$client);
      await expect(legacyMigrate(db)).rejects.toThrow(
        /Missing applied migration timestamps/,
      );
      expect(describeDatabase(db.$client)).toEqual(before);
      expectScenario("row8-mid-chain-null", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: a NULL created_at on the last step re-appends it and runs it again",
    async () => {
      const { db, flags } = await groupedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      const qtmBefore = digestTable(db.$client, "queued_thread_messages");
      db.$client.exec(
        "UPDATE __drizzle_migrations SET created_at = NULL WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)",
      );
      await legacyMigrate(db);
      const rows = ledgerRows(db.$client);
      expect(rows).toHaveLength(153);
      expect(rows.filter((row) => row.created_at === null)).toHaveLength(1);
      expect(rows[152]?.created_at).not.toBeNull();
      const after: Record<string, number> = {};
      for (const row of db.$client
        .prepare(
          "SELECT id, group_with_next AS flag FROM queued_thread_messages",
        )
        .all() as Array<{ id: string; flag: number }>)
        after[row.id] = row.flag;
      expect(after).toEqual(flags);
      const qtmAfter = digestTable(db.$client, "queued_thread_messages");
      expect(qtmAfter).not.toEqual(qtmBefore);
      expect({ qtmBefore, qtmAfter }).toMatchInlineSnapshot(`
        {
          "qtmAfter": {
            "count": 3,
            "digest": "3994632346e51c2246282bc862112c4d",
          },
          "qtmBefore": {
            "count": 3,
            "digest": "e8d206eb84135a7d776cb3a5e1c0725b",
          },
        }
      `);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([
        expect.stringContaining("table differs: queued_thread_messages"),
      ]);
      expectScenario("row8-last-null", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 20: an all-NULL ledger fails on a duplicate column after partially re-applying steps",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec("UPDATE __drizzle_migrations SET created_at = NULL");
      let failure: unknown;
      try {
        await legacyMigrate(db);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Failed to run the query/);
      expect(String((failure as Error & { cause?: unknown }).cause)).toMatch(
        /duplicate column name: name/,
      );
      expect(ledgerRows(db.$client).length).toBeGreaterThan(152);
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ).length,
      ).toBeGreaterThan(0);
      expectScenario("row20-all-null", db);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 21: an upstream-written ledger (0143 recorded, no A0009) is refused with a SQL error and left unchanged",
    async () => {
      const db = await populatedUpstreamDatabase();
      expect(ledgerRows(db.$client)).toHaveLength(144);
      const before = describeDatabase(db.$client);
      await expect(legacyMigrate(db)).rejects.toThrow(/thread_pruning_work/);
      expect(describeDatabase(db.$client)).toEqual(before);
      expect(ledgerRows(db.$client)).toHaveLength(144);
      expectScenario("row21-upstream-ledger", db);
      db.$client.close();
    },
    TIMEOUT,
  );
});
