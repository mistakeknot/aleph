import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import Database from "better-sqlite3";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "./contracts.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function delayedAccountReads(kv: PluginKvStorage): PluginKvStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await kv.get<T>(key);
      if (key === "accounts:v1") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return value;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: (prefix) => kv.list(prefix),
  };
}

describe("AccountStore", () => {
  it("loads account metadata written before account UUIDs were stored", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const store = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await host.bb.storage.kv.set("accounts:v1", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "claude",
        kind: "oauth",
        label: "existing",
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
        createdAt: 1,
      },
    ]);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountUuid: null }),
    ]);
  });

  it("preserves both accounts added concurrently", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const secretsDir = path.join(dataDir, "secrets");
    const store = new AccountStore(
      delayedAccountReads(host.bb.storage.kv),
      secretsDir,
    );
    await store.initialize();
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const account = (
      label: string,
    ): Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"> => ({
      provider: "claude",
      kind: "api-key",
      label,
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    });

    const [first, second] = await Promise.all([
      store.add(account("first"), { kind: "api-key", apiKey: "sk-first" }),
      store.add(account("second"), { kind: "api-key", apiKey: "sk-second" }),
    ]);

    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

describe("QuotaStore", () => {
  it("migrates an existing quota table to family observations", () => {
    const database = new Database(":memory:");
    const initial = QUOTA_MIGRATIONS[0];
    const familyMigration = QUOTA_MIGRATIONS[1];
    const windowMigration = QUOTA_MIGRATIONS[2];
    if (
      initial === undefined ||
      familyMigration === undefined ||
      windowMigration === undefined
    ) {
      throw new Error("Expected quota migrations.");
    }
    database.exec(initial);
    database
      .prepare(
        `INSERT INTO account_quota (
          account_id, seven_day_utilization, bucket_exhaustion_json
        ) VALUES (?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        0.5,
        '{"7d_oi":4102452000000}',
      );
    database.exec(familyMigration);
    database.exec(windowMigration);
    for (const migration of QUOTA_MIGRATIONS.slice(3)) database.exec(migration);
    const quotas = new QuotaStore(database);

    const migrated = quotas.get("11111111-1111-4111-8111-111111111111");
    expect(migrated.limitWindows).toEqual([
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.5,
        resetAt: null,
        status: null,
        observedAt: 0,
        source: "header",
      },
    ]);
    expect(migrated.extraUsage).toBeNull();
    expect(migrated.familyWeekly).toEqual({
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    });
    quotas.put({
      ...migrated,
      familyWeekly: {
        ...migrated.familyWeekly,
        fable: {
          utilization: 1,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: 10,
          source: "usage",
        },
      },
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").familyWeekly.fable,
    ).toMatchObject({ utilization: 1, source: "usage" });
    quotas.put({
      ...migrated,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          resetAt: 4_102_452_000_000,
          status: "allowed",
          observedAt: 10,
          source: "usage",
        },
      ],
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").limitWindows,
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: 4_102_452_000_000,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    database.close();
  });

  describe("reader hardening against later schema additions", () => {
    const accountId = "22222222-2222-4222-8222-222222222222";

    function migratedDatabase(): Database.Database {
      const database = new Database(":memory:");
      for (const migration of QUOTA_MIGRATIONS) database.exec(migration);
      return database;
    }

    function addFutureSchema(database: Database.Database): void {
      database.exec(`
        ALTER TABLE account_quota ADD COLUMN future_marker TEXT;
        CREATE TABLE account_quota_evidence (
          account_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          mutation INTEGER NOT NULL,
          evidence_json TEXT NOT NULL
        );
        CREATE TABLE account_quota_mutation (
          account_id TEXT PRIMARY KEY,
          mutation INTEGER NOT NULL
        );
        CREATE TRIGGER account_quota_mutation_insert AFTER INSERT ON account_quota
        BEGIN
          INSERT INTO account_quota_mutation(account_id, mutation)
            SELECT NEW.account_id, 0 WHERE NOT EXISTS (
              SELECT 1 FROM account_quota_mutation WHERE account_id = NEW.account_id
            );
          UPDATE account_quota_mutation SET mutation = mutation + 1
            WHERE account_id = NEW.account_id;
        END;
        CREATE TRIGGER account_quota_mutation_update AFTER UPDATE ON account_quota
        BEGIN
          INSERT INTO account_quota_mutation(account_id, mutation)
            SELECT NEW.account_id, 0 WHERE NOT EXISTS (
              SELECT 1 FROM account_quota_mutation WHERE account_id = NEW.account_id
            );
          UPDATE account_quota_mutation SET mutation = mutation + 1
            WHERE account_id = NEW.account_id;
        END;
        CREATE TRIGGER account_quota_mutation_delete AFTER DELETE ON account_quota
        BEGIN
          INSERT INTO account_quota_mutation(account_id, mutation)
            SELECT OLD.account_id, 0 WHERE NOT EXISTS (
              SELECT 1 FROM account_quota_mutation WHERE account_id = OLD.account_id
            );
          UPDATE account_quota_mutation SET mutation = mutation + 1
            WHERE account_id = OLD.account_id;
        END;
      `);
    }

    function mutationCount(database: Database.Database): number | undefined {
      const row = database
        .prepare(
          "SELECT mutation FROM account_quota_mutation WHERE account_id = ?",
        )
        .get(accountId) as { mutation: number } | undefined;
      return row?.mutation;
    }

    const storedWindows = JSON.stringify([
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 0.25,
        resetAt: 4102452000000,
        status: "allowed",
        observedAt: 100,
        source: "header",
      },
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.5,
        resetAt: 4102452000000,
        status: "allowed",
        observedAt: 100,
        source: "header",
      },
    ]);

    function legacyInsert(database: Database.Database): void {
      database
        .prepare(
          `INSERT INTO account_quota (
            account_id, representative_claim, bucket_exhaustion_json,
            family_weekly_json, limit_windows_json, extra_usage_json,
            usage_restriction_json, observed_at, held_until, error
          ) VALUES (?, 'five_hour', '{}',
            '{"fable":null,"sonnet":null,"opus":null,"haiku":null,"other":null}',
            ?, 'null', 'null', 100, NULL, NULL)`,
        )
        .run(accountId, storedWindows);
    }

    it("reads a database written by the current schema", () => {
      const database = migratedDatabase();
      legacyInsert(database);

      const quota = new QuotaStore(database).get(accountId);

      expect(quota).toMatchObject({
        accountId,
        limitWindows: [
          expect.objectContaining({ slot: "primary", utilization: 0.25 }),
          expect.objectContaining({ slot: "secondary", utilization: 0.5 }),
        ],
        representativeClaim: "five_hour",
        observedAt: 100,
      });
      database.close();
    });

    it("reads quota rows when later columns, tables and triggers exist", () => {
      const database = migratedDatabase();
      legacyInsert(database);
      addFutureSchema(database);
      database.prepare("UPDATE account_quota SET future_marker = 'x'").run();

      const unrestricted = database
        .prepare("SELECT * FROM account_quota WHERE account_id = ?")
        .get(accountId) as Record<string, unknown>;
      expect(unrestricted).toHaveProperty("future_marker", "x");

      const quota = new QuotaStore(database).get(accountId);

      expect(quota).toMatchObject({
        accountId,
        limitWindows: [
          expect.objectContaining({ slot: "primary", utilization: 0.25 }),
          expect.objectContaining({ slot: "secondary", utilization: 0.5 }),
        ],
        observedAt: 100,
      });
      expect(Object.keys(quota)).not.toContain("futureMarker");
      database.close();
    });

    it("keeps the upsert and delete working while the triggers fire", () => {
      const database = migratedDatabase();
      addFutureSchema(database);
      const quotas = new QuotaStore(database);
      const base = quotas.get(accountId);

      const withUtilization = (utilization: number) => [
        {
          slot: "primary" as const,
          windowMinutes: 300,
          utilization,
          resetAt: null,
          status: null,
          observedAt: 1,
          source: "header" as const,
        },
      ];
      quotas.put({ ...base, limitWindows: withUtilization(0.1), observedAt: 1 });
      expect(mutationCount(database)).toBe(1);

      quotas.put({ ...base, limitWindows: withUtilization(0.4), observedAt: 2 });
      expect(mutationCount(database)).toBe(2);
      expect(quotas.get(accountId)).toMatchObject({
        limitWindows: [expect.objectContaining({ utilization: 0.4 })],
        observedAt: 2,
      });

      quotas.remove(accountId);
      expect(mutationCount(database)).toBe(3);
      expect(quotas.get(accountId).observedAt).toBeNull();
      database.close();
    });
  });

  it("moves stored Claude five-hour and seven-day columns into limit windows", () => {
    const database = new Database(":memory:");
    const moveMigration = QUOTA_MIGRATIONS.length - 1;
    for (const migration of QUOTA_MIGRATIONS.slice(0, moveMigration))
      database.exec(migration);
    const claudeId = "11111111-1111-4111-8111-111111111111";
    const codexId = "22222222-2222-4222-8222-222222222222";
    const codexWindows = JSON.stringify([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: null,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    const insert = database.prepare(
      `INSERT INTO account_quota (
        account_id, five_hour_utilization, five_hour_reset_at, five_hour_status,
        seven_day_utilization, seven_day_reset_at, seven_day_status,
        limit_windows_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      claudeId,
      1,
      4_102_444_800_000,
      "rejected",
      0.25,
      4_102_448_400_000,
      "allowed",
      "[]",
      50,
    );
    insert.run(codexId, null, null, null, null, null, null, codexWindows, 60);
    database.exec(QUOTA_MIGRATIONS[moveMigration] ?? "");
    const quotas = new QuotaStore(database);

    expect(quotas.get(claudeId).limitWindows).toEqual([
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 1,
        resetAt: 4_102_444_800_000,
        status: "rejected",
        observedAt: 50,
        source: "header",
      },
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.25,
        resetAt: 4_102_448_400_000,
        status: "allowed",
        observedAt: 50,
        source: "header",
      },
    ]);
    expect(quotas.get(codexId).limitWindows).toEqual(JSON.parse(codexWindows));
    expect(
      database
        .prepare(
          `SELECT count(*) AS stale FROM account_quota
           WHERE five_hour_utilization IS NOT NULL OR five_hour_status IS NOT NULL
             OR seven_day_utilization IS NOT NULL OR seven_day_status IS NOT NULL`,
        )
        .get(),
    ).toEqual({ stale: 0 });
    database.close();
  });

  it("reads and writes quotas when a newer build has added a column", () => {
    const database = new Database(":memory:");
    for (const migration of QUOTA_MIGRATIONS) database.exec(migration);
    database.exec(
      "ALTER TABLE account_quota ADD COLUMN later_json TEXT NOT NULL DEFAULT '{}'",
    );
    const quotas = new QuotaStore(database);
    const accountId = "11111111-1111-4111-8111-111111111111";

    quotas.put({ ...quotas.get(accountId), representativeClaim: "five_hour" });

    expect(quotas.get(accountId).representativeClaim).toBe("five_hour");
    database.close();
  });
});
