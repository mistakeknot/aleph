import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.js";
import type { DbConnection } from "../src/connection.js";
import {
  contentOnly,
  describeDatabase,
  diffDescriptions,
} from "./helpers/migration-equality.js";
import {
  legacyMigrate,
  pinMigrationClock,
  populatedPrefixDatabase,
} from "./helpers/migration-scenarios.js";

const TIMEOUT = 300_000;

async function pendingDeleteDatabase(length: number): Promise<DbConnection> {
  const db = await populatedPrefixDatabase(length);
  db.$client.exec(
    "UPDATE project_operations SET kind = 'delete', state = 'requested' WHERE rowid = 1",
  );
  return db;
}

function describeAfter(db: DbConnection) {
  pinMigrationClock(db.$client);
  return describeDatabase(db.$client);
}

describe("runner equals the legacy runner at deferred-cleanup prefixes", () => {
  for (const length of [15]) {
    it(
      `matches the legacy runner at populated prefix ${length} with a pending project delete`,
      async () => {
        const legacy = await pendingDeleteDatabase(length);
        await legacyMigrate(legacy);
        const expected = describeAfter(legacy);
        const hadOperations = legacy.$client
          .prepare("SELECT COUNT(*) AS n FROM project_operations")
          .get() as { n: number };
        legacy.$client.close();

        const candidate = await pendingDeleteDatabase(length);
        migrate(candidate);
        const actual = describeAfter(candidate);
        const operations = candidate.$client
          .prepare("SELECT COUNT(*) AS n FROM project_operations")
          .get() as { n: number };
        candidate.$client.close();

        expect(operations.n).toBe(hadOperations.n);
        expect(
          diffDescriptions(contentOnly(expected), contentOnly(actual)).filter(
            (line) => !line.includes("__bb_migration_ledger"),
          ),
        ).toEqual([]);
      },
      TIMEOUT,
    );
  }
});
