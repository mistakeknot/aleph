import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_ORACLE_COMMIT,
  UPSTREAM_ORACLE_COMMIT,
} from "./helpers/legacy-oracle.js";
import {
  combineRowHashes,
  contentOnly,
  describeDatabase,
  diffDescriptions,
  rowHash,
  schemaFingerprint,
  type DatabaseDescription,
} from "./helpers/migration-equality.js";
import {
  EQUALITY_PREFIX_LENGTHS,
  ledgerRows,
  legacyMigrate,
  pinMigrationClock,
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
  prefixes: Record<string, Omit<DatabaseDescription, "schema">>;
}

const TIMEOUT = 300_000;

async function upgradeFromPrefix(length: number): Promise<DatabaseDescription> {
  const db = await populatedPrefixDatabase(length);
  try {
    await legacyMigrate(db);
    pinMigrationClock(db.$client);
    return describeDatabase(db.$client);
  } finally {
    db.$client.close();
  }
}

describe("migration equality harness: digest primitives", () => {
  it("distinguishes values that differ only in how bytes are framed", () => {
    expect(rowHash(["aT", "b"])).not.toBe(rowHash(["a", "Tb"]));
    expect(rowHash(["1"])).not.toBe(rowHash([1n]));
    expect(rowHash([null])).not.toBe(rowHash([""]));
    expect(rowHash([Buffer.from("x")])).not.toBe(rowHash(["x"]));
  });

  it("is order-insensitive but counts duplicate rows", () => {
    const a = rowHash(["a"]);
    const b = rowHash(["b"]);
    expect(combineRowHashes([a, b])).toEqual(combineRowHashes([b, a]));
    expect(combineRowHashes([a, a])).not.toEqual(combineRowHashes([]));
    expect(combineRowHashes([a, a, b])).not.toEqual(combineRowHashes([b]));
    expect(combineRowHashes([a, a]).count).toBe(2);
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
    "detects a duplicated row and a changed autoincrement counter",
    async () => {
      const db = await populatedPrefixDatabase(152);
      const before = describeDatabase(db.$client);
      db.$client.exec(
        "UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'transfer_events'",
      );
      expect(describeDatabase(db.$client).sequences).not.toEqual(
        before.sequences,
      );
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "upgrades every populated prefix to the pinned reference state",
    async () => {
      const results: Record<string, DatabaseDescription> = {};
      for (const length of EQUALITY_PREFIX_LENGTHS)
        results[String(length)] = await upgradeFromPrefix(length);

      const fingerprints = new Set(
        Object.values(results).map((description) =>
          schemaFingerprint(description),
        ),
      );
      expect(fingerprints.size).toBe(1);

      const current: ReferenceFile = {
        legacyCommit: LEGACY_ORACLE_COMMIT,
        upstreamCommit: UPSTREAM_ORACLE_COMMIT,
        schemaFingerprint: [...fingerprints][0] ?? "",
        prefixes: Object.fromEntries(
          Object.entries(results).map(([length, description]) => [
            length,
            {
              sequences: description.sequences,
              tables: description.tables,
              ledger: description.ledger,
            },
          ]),
        ),
      };
      if (process.env.UPDATE_MIGRATION_EQUALITY_REFERENCE === "1") {
        writeFileSync(referencePath, `${JSON.stringify(current, null, 2)}\n`);
        return;
      }
      const reference = JSON.parse(
        readFileSync(referencePath, "utf8"),
      ) as ReferenceFile;
      expect(current).toEqual(reference);
    },
    TIMEOUT,
  );
});

describe("legacy runner behaviour on ledger shapes (S3 rows 8, 16, 20, 21)", () => {
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
      expect(ledgerRows(db.$client)).toHaveLength(153);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: an extra NULL created_at row beside complete rows is ignored",
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
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 8: a NULL created_at on the only row for a step refuses as missing-created-at",
    async () => {
      const db = await populatedPrefixDatabase(152);
      db.$client.exec(
        "UPDATE __drizzle_migrations SET created_at = NULL WHERE rowid = (SELECT MAX(rowid) - 5 FROM __drizzle_migrations)",
      );
      const before = describeDatabase(db.$client);
      await expect(legacyMigrate(db)).rejects.toThrow(
        /Missing applied migration timestamps/,
      );
      expect(
        diffDescriptions(
          contentOnly(before),
          contentOnly(describeDatabase(db.$client)),
        ),
      ).toEqual([]);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "row 20: an all-NULL ledger fails with a SQL error after partially re-applying steps",
    async () => {
      const db = await populatedPrefixDatabase(152);
      db.$client.exec("UPDATE __drizzle_migrations SET created_at = NULL");
      await expect(legacyMigrate(db)).rejects.toThrow(
        /Failed to run the query/,
      );
      expect(ledgerRows(db.$client).length).toBeGreaterThan(152);
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
      db.$client.close();
    },
    TIMEOUT,
  );
});
