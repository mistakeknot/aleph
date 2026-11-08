import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_FAMILY_WEEKLY,
  quotaSchema,
  windowEvidenceSchema,
  type AccountQuota,
  type QuotaEvidenceCurrent,
  type QuotaEvidenceUpdater,
} from "./contracts.js";
import { runPluginStorageMigrations as runA0Migrations } from "./fixtures/legacy-builds/a0/migration-runner.js";
import {
  QUOTA_MIGRATIONS as A0_MIGRATIONS,
  QuotaStore as A0QuotaStore,
} from "./fixtures/legacy-builds/a0/store.js";
import { runPluginStorageMigrations as runOldMigrations } from "./fixtures/legacy-builds/old/migration-runner.js";
import {
  QUOTA_MIGRATIONS as OLD_MIGRATIONS,
  QuotaStore as OldQuotaStore,
} from "./fixtures/legacy-builds/old/store.js";
import type { QuotaSampler } from "./quota-history.js";
import { QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const accountId = "33333333-3333-4333-8333-333333333333";
const otherAccountId = "44444444-4444-4444-8444-444444444444";
const thirdAccountId = "55555555-5555-4555-8555-555555555555";
const OLD_COMMIT = "cd650e592e018b8c63b0f2f2b43075480f51c481";
const A0_COMMIT = "db0226b7d170e21aa9a960cdfd0b08947a4bca75";

interface LegacyQuotas {
  get(accountId: string): AccountQuota;
  put(quota: AccountQuota): void;
  remove(accountId: string): void;
}

const legacyBuilds = {
  old: {
    migrations: OLD_MIGRATIONS,
    start: runOldMigrations,
    open: (database: Database.Database): LegacyQuotas =>
      new OldQuotaStore(database),
  },
  a0: {
    migrations: A0_MIGRATIONS,
    start: runA0Migrations,
    open: (database: Database.Database): LegacyQuotas =>
      new A0QuotaStore(database),
  },
};
type LegacyName = keyof typeof legacyBuilds;
const LEGACY_NAMES: LegacyName[] = ["old", "a0"];

let directory: string;
let databases: Database.Database[];
let migrate: (db: Database.Database, statements: string[]) => void;
let stopHost: () => Promise<void>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "bb-quota-evidence-"));
  databases = [];
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir: directory,
  });
  migrate = host.bb.storage.migrate;
  stopHost = async () => {
    await host.harness.lifecycle.dispose();
  };
});

afterEach(async () => {
  for (const database of databases) {
    if (database.open) database.close();
  }
  await stopHost();
  await rm(directory, { recursive: true, force: true });
});

function open(file = "pool.db", timeout = 5_000): Database.Database {
  const database = new Database(path.join(directory, file), { timeout });
  database.pragma("journal_mode = WAL");
  databases.push(database);
  return database;
}

function migrated(database = open()): Database.Database {
  migrate(database, QUOTA_MIGRATIONS);
  return database;
}

function startLegacy(name: LegacyName, database: Database.Database) {
  legacyBuilds[name].start(database, legacyBuilds[name].migrations);
}

function legacyMigrated(
  name: LegacyName = "old",
  database = open(),
): Database.Database {
  startLegacy(name, database);
  return database;
}

function legacy(name: LegacyName, database: Database.Database): LegacyQuotas {
  return legacyBuilds[name].open(database);
}

function emptyQuota(id: string): AccountQuota {
  return quotaSchema.parse({
    accountId: id,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
  });
}

type QuotaChange = AccountQuota | ((current: AccountQuota) => AccountQuota);

function stampAll(
  entries: Record<string, number>,
  change: QuotaChange = (current) => current,
): QuotaEvidenceUpdater {
  return ({ quota, evidence, seq }) => {
    const windows = { ...evidence.evidence.windows };
    for (const [key, at] of Object.entries(entries)) {
      windows[key] = {
        ...windowEvidenceSchema.parse({}),
        ...windows[key],
        utilizationAt: at,
        utilizationSeq: seq,
        reportedAt: at,
        lastSeq: seq,
      };
    }
    return {
      quota: typeof change === "function" ? change(quota) : change,
      evidence: {
        windows,
        removed: evidence.evidence.removed,
        classUncertain: evidence.evidence.classUncertain,
        snapshotSeq: evidence.evidence.snapshotSeq,
      },
    };
  };
}

function stamp(
  key: string,
  at: number,
  change: QuotaChange = (current) => current,
): QuotaEvidenceUpdater {
  return stampAll({ [key]: at }, change);
}

function quotaWith(overrides: Partial<AccountQuota>): AccountQuota {
  return { ...emptyQuota(accountId), ...overrides };
}

function mutation(
  database: Database.Database,
  id = accountId,
): number | undefined {
  const row = database
    .prepare("SELECT mutation FROM account_quota_mutation WHERE account_id = ?")
    .get(id) as { mutation: number } | undefined;
  return row?.mutation;
}

function evidenceRow(database: Database.Database, id = accountId) {
  return database
    .prepare("SELECT * FROM account_quota_evidence WHERE account_id = ?")
    .get(id) as
    | { seq: number; mutation: number; evidence_json: string }
    | undefined;
}

function columns(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((column) => column.name);
}

const base = quotaWith({
  fiveHourUtilization: 0.3,
  fiveHourResetAt: 4_102_452_000_000,
  fiveHourStatus: "allowed",
  sevenDayUtilization: 0.4,
  sevenDayResetAt: 4_102_452_000_000,
  sevenDayStatus: "allowed",
  observedAt: 100,
});

const baseForOther = { ...base, accountId: otherAccountId };

function seed(database: Database.Database, id = accountId) {
  new QuotaStore(database).update(
    id,
    stampAll(
      { "shared:5h": 1_000, "shared:7d": 1_000 },
      { ...base, accountId: id },
    ),
  );
}

describe("vendored legacy builds", () => {
  const vendored = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/legacy-builds",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(vendored, "manifest.json"), "utf8"),
  ) as {
    builds: Record<string, { commit: string; files: Record<string, string> }>;
  };

  it("pins the commits before and after the explicit column list change", () => {
    expect(manifest.builds.old?.commit).toBe(OLD_COMMIT);
    expect(manifest.builds.a0?.commit).toBe(A0_COMMIT);
  });

  it.each(LEGACY_NAMES)(
    "keeps the %s files byte-identical to the pinned source",
    (name) => {
      const build = manifest.builds[name];
      expect(Object.keys(build?.files ?? {}).sort()).toEqual([
        "contracts.ts",
        "migration-runner.ts",
        "quota-history.ts",
        "store.ts",
      ]);
      for (const [file, expected] of Object.entries(build?.files ?? {})) {
        const text = readFileSync(path.join(vendored, name, file), "utf8");
        expect(createHash("sha256").update(text).digest("hex")).toBe(expected);
      }
    },
  );

  it("is the build that reads with SELECT * and a strict row schema, then the explicit list", () => {
    const oldSource = readFileSync(path.join(vendored, "old/store.ts"), "utf8");
    const a0Source = readFileSync(path.join(vendored, "a0/store.ts"), "utf8");
    expect(oldSource).toContain(
      '"SELECT * FROM account_quota WHERE account_id = ?"',
    );
    expect(a0Source).toContain("QUOTA_ROW_COLUMNS");
    expect(a0Source).not.toContain(
      '"SELECT * FROM account_quota WHERE account_id = ?"',
    );
  });

  it("shares migrations 0 through 7 with the new build, byte for byte", () => {
    expect(OLD_MIGRATIONS).toHaveLength(8);
    expect(A0_MIGRATIONS).toEqual(OLD_MIGRATIONS);
    expect(QUOTA_MIGRATIONS.slice(0, OLD_MIGRATIONS.length)).toEqual(
      OLD_MIGRATIONS,
    );
  });
});

describe("quota evidence store", () => {
  it("records the evidence migration as one appended entry", () => {
    expect(QUOTA_MIGRATIONS).toHaveLength(OLD_MIGRATIONS.length + 1);
    const database = migrated();
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'account_quota_%' ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: "account_quota_evidence" },
      { name: "account_quota_mutation" },
    ]);
    const triggers = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      )
      .all();
    expect(triggers).toEqual([
      { name: "account_quota_mutation_delete" },
      { name: "account_quota_mutation_insert" },
      { name: "account_quota_mutation_update" },
    ]);
  });

  it("backfills a counter row at zero for every existing quota row", () => {
    const database = legacyMigrated("old");
    const old = legacy("old", database);
    old.put(base);
    old.put(baseForOther);
    migrate(database, QUOTA_MIGRATIONS);

    expect(mutation(database)).toBe(0);
    expect(mutation(database, otherAccountId)).toBe(0);
    const quotas = new QuotaStore(database);
    expect(quotas.read(accountId).evidence.present).toBe(false);
    expect(quotas.read(accountId).quota.fiveHourUtilization).toBe(0.3);
  });

  it("writes the quota row and the evidence row in one transaction", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    const written = quotas.update(accountId, stamp("shared:5h", 1_000, base));

    expect(written.fiveHourUtilization).toBe(0.3);
    const row = evidenceRow(database);
    expect(row).toMatchObject({ seq: 1, mutation: mutation(database) });
    const read = quotas.read(accountId);
    expect(read.evidence).toMatchObject({ present: true, matches: true });
    expect(read.evidence.uncertain).toEqual({
      claude_usage: false,
      codex_usage: false,
    });
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: 1_000,
      utilizationSeq: 1,
    });
    expect(read.quota.fiveHourUtilization).toBe(0.3);
  });

  it("hands the updater the quota, evidence and sequence read inside the transaction", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    let seen: QuotaEvidenceCurrent | undefined;
    let inTransaction = false;

    quotas.update(accountId, (current) => {
      seen = current;
      inTransaction = database.inTransaction;
      return stamp("shared:5h", 2_000)(current);
    });

    expect(inTransaction).toBe(true);
    expect(seen?.seq).toBe(2);
    expect(seen?.quota).toEqual(base);
    expect(seen?.evidence).toMatchObject({ present: true, matches: true });
  });

  it("rejects an updated quota that belongs to another account", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);

    expect(() =>
      quotas.update(accountId, stamp("shared:5h", 1_000, baseForOther)),
    ).toThrow("different account");

    expect(evidenceRow(database)).toBeUndefined();
    expect(evidenceRow(database, otherAccountId)).toBeUndefined();
  });

  it("rolls both rows back when the updater throws", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    const before = mutation(database);

    expect(() =>
      quotas.update(accountId, () => {
        throw new Error("updater failed");
      }),
    ).toThrow("updater failed");

    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.3);
    expect(mutation(database)).toBe(before);
    expect(evidenceRow(database)?.seq).toBe(1);
  });

  it("rolls the evidence row back when the quota write fails", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    database.exec(
      "CREATE TRIGGER block_quota BEFORE INSERT ON account_quota BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );

    expect(() =>
      quotas.update(accountId, stamp("shared:5h", 1_000, base)),
    ).toThrow("blocked");

    expect(evidenceRow(database)).toBeUndefined();
    expect(mutation(database)).toBeUndefined();
  });

  it("rolls the quota row and the counter back when the evidence update fails afterwards", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    seed(database);
    const rowBefore = evidenceRow(database);
    const counterBefore = mutation(database);
    database.exec(
      "CREATE TRIGGER block_evidence_update BEFORE UPDATE ON account_quota_evidence BEGIN SELECT RAISE(ABORT, 'evidence blocked'); END",
    );

    expect(() =>
      quotas.update(
        accountId,
        stamp("shared:5h", 9_000, (current) => ({
          ...current,
          fiveHourUtilization: 0.9,
        })),
      ),
    ).toThrow("evidence blocked");

    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.3);
    expect(mutation(database)).toBe(counterBefore);
    expect(evidenceRow(database)).toEqual(rowBefore);
    expect(database.inTransaction).toBe(false);
  });

  it("rolls a first write back entirely when the evidence insert fails afterwards", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    database.exec(
      "CREATE TRIGGER block_evidence_insert BEFORE INSERT ON account_quota_evidence BEGIN SELECT RAISE(ABORT, 'evidence blocked'); END",
    );

    expect(() =>
      quotas.update(accountId, stamp("shared:5h", 1_000, base)),
    ).toThrow("evidence blocked");

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM account_quota").get(),
    ).toEqual({ count: 0 });
    expect(mutation(database)).toBeUndefined();
    expect(evidenceRow(database)).toBeUndefined();
  });

  it("rolls a removal back entirely when the evidence write fails afterwards", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    seed(database);
    const rowBefore = evidenceRow(database);
    const counterBefore = mutation(database);
    database.exec(
      "CREATE TRIGGER block_evidence_update BEFORE UPDATE ON account_quota_evidence BEGIN SELECT RAISE(ABORT, 'evidence blocked'); END",
    );

    expect(() => quotas.remove(accountId)).toThrow("evidence blocked");

    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.3);
    expect(mutation(database)).toBe(counterBefore);
    expect(evidenceRow(database)).toEqual(rowBefore);
  });

  it("records a sample after commit, and not when the update fails", () => {
    const database = migrated();
    const sampler = { record: vi.fn(), forget: vi.fn() };
    const quotas = new QuotaStore(database, sampler as unknown as QuotaSampler);

    expect(() =>
      quotas.update(accountId, () => {
        throw new Error("updater failed");
      }),
    ).toThrow("updater failed");
    expect(sampler.record).not.toHaveBeenCalled();

    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    expect(sampler.record).toHaveBeenCalledTimes(1);
    expect(sampler.record).toHaveBeenCalledWith(base);
  });

  it("serializes writers: an older build is locked out mid-transaction", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    const blocked = legacy("old", open("pool.db", 0));
    let attempt: unknown;

    quotas.update(accountId, (current) => {
      try {
        blocked.put({ ...base, fiveHourUtilization: 0.99 });
      } catch (error) {
        attempt = error;
      }
      return stamp("shared:5h", 1_000, base)(current);
    });

    expect(attempt).toMatchObject({ code: "SQLITE_BUSY" });
    expect(quotas.read(accountId).evidence.matches).toBe(true);
    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.3);
  });

  it("is locked out at transaction entry while an older build holds the write lock", () => {
    const database = migrated(open("pool.db", 0));
    const quotas = new QuotaStore(database);
    seed(database);
    const holder = open("pool.db", 0);
    const updater = vi.fn(stamp("shared:5h", 4_000));
    let attempt: unknown;

    holder
      .transaction(() => {
        legacy("old", holder).put({ ...base, observedAt: 700 });
        try {
          quotas.update(accountId, updater);
        } catch (error) {
          attempt = error;
        }
      })
      .immediate();

    expect(attempt).toMatchObject({ code: "SQLITE_BUSY" });
    expect(updater).not.toHaveBeenCalled();
    expect(database.inTransaction).toBe(false);

    quotas.update(accountId, updater);

    expect(updater).toHaveBeenCalledTimes(1);
    const current = updater.mock.calls[0]?.[0];
    expect(current?.quota.observedAt).toBe(700);
    expect(current?.evidence.matches).toBe(false);
    expect(quotas.read(accountId).evidence.matches).toBe(true);
  });

  it("supports nested reads and writes on the shared connection", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    seed(database);
    let nestedRead: ReturnType<QuotaStore["read"]> | undefined;

    quotas.update(accountId, (current) => {
      nestedRead = quotas.read(accountId);
      quotas.put(baseForOther);
      return stamp("shared:5h", 2_000, {
        ...current.quota,
        fiveHourUtilization: 0.6,
      })(current);
    });

    expect(nestedRead?.quota.fiveHourUtilization).toBe(0.3);
    expect(nestedRead?.evidence.matches).toBe(true);
    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.6);
    expect(quotas.get(otherAccountId).fiveHourUtilization).toBe(0.3);
    expect(quotas.read(accountId).evidence.matches).toBe(true);
  });

  it("rolls nested writes back with the outer update", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    seed(database);

    expect(() =>
      quotas.update(accountId, () => {
        quotas.put(baseForOther);
        throw new Error("updater failed");
      }),
    ).toThrow("updater failed");

    expect(quotas.get(otherAccountId).observedAt).toBeNull();
    expect(mutation(database, otherAccountId)).toBeUndefined();
    expect(quotas.read(accountId).evidence.matches).toBe(true);
  });

  it("drops only freshness stamps on a counter mismatch", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, (current) => {
      const document = stamp("shared:5h", 1_000, base)(current).evidence;
      const window = document.windows["shared:5h"];
      if (window === undefined) throw new Error("missing window");
      document.windows["shared:5h"] = {
        ...window,
        statusAt: 1_000,
        resetSeenAt: 1_000,
        durationAt: 1_000,
        utilizationInvalidAt: 900,
        utilizationInvalidSeq: 1,
        restrictSeq: 1,
      };
      document.removed = { "family:opus": 1 };
      document.snapshotSeq = { claude_usage: 1, codex_usage: null };
      return { quota: base, evidence: document };
    });
    legacy("old", database).put({ ...base, observedAt: 200 });

    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(false);
    expect(read.evidence.uncertain).toEqual({
      claude_usage: true,
      codex_usage: true,
    });
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: null,
      statusAt: null,
      resetSeenAt: null,
      durationAt: null,
      reportedAt: 1_000,
      utilizationInvalidAt: 900,
      utilizationInvalidSeq: 1,
      restrictSeq: 1,
    });
    expect(read.evidence.evidence.removed).toEqual({ "family:opus": 1 });
    expect(read.evidence.evidence.snapshotSeq).toEqual({
      claude_usage: 1,
      codex_usage: null,
    });
  });

  it("reads a missing counter row as a mismatch", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    database.prepare("DELETE FROM account_quota_mutation").run();

    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(false);
    expect(read.evidence.uncertain.claude_usage).toBe(true);
    expect(
      read.evidence.evidence.windows["shared:5h"]?.utilizationAt,
    ).toBeNull();
  });

  it("reads rows without an evidence row as legacy, not uncertain", () => {
    const database = migrated();
    legacy("old", database).put(base);

    const read = new QuotaStore(database).read(accountId);
    expect(read.evidence.present).toBe(false);
    expect(read.evidence.evidence.windows).toEqual({});
    expect(read.evidence.uncertain).toEqual({
      claude_usage: false,
      codex_usage: false,
    });
  });

  it("does not read evidence that has no quota row", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    database.prepare("DELETE FROM account_quota").run();

    const read = quotas.read(accountId);
    expect(read.evidence.present).toBe(false);
    expect(read.evidence.evidence.windows).toEqual({});
  });

  it.each([
    ["invalid json", "not json"],
    ["a document of the wrong shape", JSON.stringify({ windows: 7 })],
  ])(
    "reads an unreadable evidence document (%s) as uncertain",
    (_name, body) => {
      const database = migrated();
      const quotas = new QuotaStore(database);
      quotas.put(base);
      database
        .prepare("INSERT INTO account_quota_evidence VALUES (?, 3, ?, ?)")
        .run(accountId, mutation(database), body);

      const read = quotas.read(accountId);
      expect(read.evidence.present).toBe(true);
      expect(read.evidence.matches).toBe(false);
      expect(read.evidence.uncertain).toEqual({
        claude_usage: true,
        codex_usage: true,
      });

      let seen: QuotaEvidenceCurrent | undefined;
      quotas.update(accountId, (current) => {
        seen = current;
        return stamp("shared:5h", 1_000)(current);
      });
      expect(seen?.evidence.matches).toBe(false);
      expect(quotas.read(accountId).evidence.evidence.seq).toBe(4);
      expect(quotas.read(accountId).evidence.matches).toBe(true);
    },
  );

  it("ignores unknown keys inside evidence_json", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(base);
    const document = {
      futureTopLevel: { anything: true },
      windows: {
        "shared:5h": {
          ...windowEvidenceSchema.parse({}),
          utilizationAt: 5,
          futureStamp: 9,
        },
      },
      removed: {},
      classUncertain: { claude_usage: null, codex_usage: null, other: 1 },
      snapshotSeq: { claude_usage: null, codex_usage: null },
    };
    database
      .prepare("INSERT INTO account_quota_evidence VALUES (?, 4, ?, ?)")
      .run(accountId, mutation(database), JSON.stringify(document));

    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(true);
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: 5,
    });
    expect(read.evidence.evidence.windows["shared:5h"]).not.toHaveProperty(
      "futureStamp",
    );
    expect(read.evidence.evidence).not.toHaveProperty("futureTopLevel");
  });

  it("converts a mismatched row before the updater runs", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, stamp("shared:5h", 1_000, base));
    legacy("old", database).put({ ...base, observedAt: 200 });
    let seen: QuotaEvidenceCurrent | undefined;

    quotas.update(accountId, (current) => {
      seen = current;
      return stamp("shared:7d", 2_000)(current);
    });

    expect(seen?.evidence.matches).toBe(false);
    expect(seen?.evidence.uncertain).toEqual({
      claude_usage: true,
      codex_usage: true,
    });
    expect(seen?.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: null,
      lastSeq: 2,
    });
    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(true);
    expect(read.evidence.evidence.seq).toBe(2);
    expect(read.evidence.evidence.classUncertain).toEqual({
      claude_usage: 2,
      codex_usage: 2,
    });
    expect(read.evidence.evidence.windows["shared:7d"]).toMatchObject({
      utilizationAt: 2_000,
      utilizationSeq: 2,
    });
    expect(
      read.evidence.evidence.windows["shared:5h"]?.utilizationAt,
    ).toBeNull();
  });

  it("keeps a reduced evidence row and the counter when an account is deleted", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, (current) => ({
      ...stamp(
        "shared:5h",
        1_000,
        quotaWith({
          ...base,
          familyWeekly: {
            fable: null,
            sonnet: {
              utilization: 0.1,
              resetAt: 4_102_452_000_000,
              status: "allowed",
              observedAt: 1,
              source: "header",
            },
            opus: null,
            haiku: null,
            other: null,
          },
          limitWindows: [
            {
              slot: "primary",
              windowMinutes: 300,
              utilization: 0.2,
              resetAt: 4_102_452_000_000,
              status: null,
              observedAt: 1,
              source: "usage",
            },
          ],
        }),
      )(current),
      evidence: {
        ...stamp("shared:5h", 1_000)(current).evidence,
        snapshotSeq: { claude_usage: 1, codex_usage: null },
      },
    }));

    quotas.remove(accountId);

    expect(quotas.get(accountId).observedAt).toBeNull();
    expect(mutation(database)).toBe(2);
    const row = evidenceRow(database);
    expect(row).toMatchObject({ seq: 2, mutation: 2 });
    const document = JSON.parse(row?.evidence_json ?? "{}");
    expect(document.windows).toEqual({});
    expect(document.snapshotSeq).toEqual({
      claude_usage: 1,
      codex_usage: null,
    });
    expect(Object.keys(document.removed).sort()).toEqual([
      "family:sonnet",
      "limit:primary",
      "shared:5h",
      "shared:7d",
    ]);
    expect(Object.values(document.removed)).toEqual([2, 2, 2, 2]);
    expect(quotas.read(accountId).evidence.present).toBe(false);
  });

  it("keeps removed and snapshot sequence numbers when an account returns", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.update(accountId, (current) => ({
      quota: base,
      evidence: {
        ...stamp("shared:5h", 1_000)(current).evidence,
        snapshotSeq: { claude_usage: 1, codex_usage: null },
      },
    }));
    quotas.remove(accountId);

    quotas.update(accountId, stamp("shared:5h", 3_000, base));

    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(true);
    expect(read.evidence.evidence.seq).toBe(3);
    expect(read.evidence.evidence.removed).toMatchObject({ "shared:5h": 2 });
    expect(read.evidence.evidence.snapshotSeq.claude_usage).toBe(1);
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: 3_000,
    });
  });

  it("removes an account that never had quota or evidence without writing evidence", () => {
    const database = migrated();
    new QuotaStore(database).remove(accountId);
    expect(evidenceRow(database)).toBeUndefined();
  });
});

describe("cross-version quota evidence against the real older builds", () => {
  function seeded(file = "pool.db") {
    const database = migrated(open(file));
    seed(database);
    return { database, next: new QuotaStore(database) };
  }

  function expectAllLegacy(
    read: ReturnType<QuotaStore["read"]>,
    uncertain = true,
  ) {
    expect(read.evidence.matches).toBe(false);
    expect(read.evidence.uncertain).toEqual({
      claude_usage: uncertain,
      codex_usage: uncertain,
    });
    for (const window of Object.values(read.evidence.evidence.windows)) {
      expect(window).toMatchObject({
        utilizationAt: null,
        statusAt: null,
        resetSeenAt: null,
        durationAt: null,
      });
    }
  }

  function reopen(database: Database.Database): Database.Database {
    database.close();
    return open();
  }

  it.each(LEGACY_NAMES)(
    "(a) the %s build reopens, starts up with its own migration runner and reads a database migrated by the new build",
    (name) => {
      const { database } = seeded();
      const reopened = reopen(database);

      expect(() => startLegacy(name, reopened)).not.toThrow();

      const recorded = reopened
        .prepare("SELECT COUNT(*) AS count FROM _bb_migrations")
        .get() as { count: number };
      expect(recorded.count).toBe(OLD_MIGRATIONS.length + 1);
      const build = legacy(name, reopened);
      expect(build.get(accountId)).toMatchObject({
        accountId,
        fiveHourUtilization: 0.3,
        sevenDayUtilization: 0.4,
        observedAt: 100,
      });
      expect(build.get(otherAccountId).observedAt).toBeNull();
    },
  );

  it.each(LEGACY_NAMES)(
    "(a) the %s build's own runner refuses to start when a shared migration changes",
    (name) => {
      const { database } = seeded();
      const changed = [...legacyBuilds[name].migrations];
      changed[3] = `${changed[3]}\n-- changed`;

      expect(() => legacyBuilds[name].start(database, changed)).toThrow(
        "does not match the recorded statement",
      );
    },
  );

  it.each([
    ["header write", { fiveHourUtilization: 0.35, observedAt: 150 }],
    ["usage poll", { sevenDayUtilization: 0.45, observedAt: 160 }],
    ["hold", { heldUntil: 4_102_452_000_000 }],
    ["error write", { error: "upstream failed" }],
  ] as const)(
    "(b) an older build's %s leaves the new build reading every window as legacy",
    (_name, change) => {
      for (const name of LEGACY_NAMES) {
        const { database, next } = seeded(`${name}.db`);
        const build = legacy(name, database);
        build.put({ ...build.get(accountId), ...change });

        expect(mutation(database)).toBe(
          (evidenceRow(database)?.mutation ?? 0) + 1,
        );
        const read = next.read(accountId);
        expectAllLegacy(read);
        expect(Object.keys(read.evidence.evidence.windows).sort()).toEqual([
          "shared:5h",
          "shared:7d",
        ]);
      }
    },
  );

  it("(c) new-build writes after an older build evidence only the windows it reports", () => {
    const { database, next } = seeded();
    const old = legacy("old", database);
    old.put({ ...old.get(accountId), fiveHourUtilization: 0.5 });
    next.update(accountId, stamp("shared:5h", 5_000, old.get(accountId)));

    const read = next.read(accountId);
    expect(read.evidence.matches).toBe(true);
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: 5_000,
    });
    expect(read.evidence.evidence.windows["shared:7d"]).toMatchObject({
      utilizationAt: null,
      lastSeq: 2,
    });
    expect(read.evidence.uncertain).toEqual({
      claude_usage: true,
      codex_usage: true,
    });
    expect(mutation(database)).toBe(evidenceRow(database)?.mutation);
  });

  it("(c) a legacy row without evidence gets evidence only for reported windows", () => {
    const database = migrated();
    const next = new QuotaStore(database);
    legacy("old", database).put(base);
    next.update(accountId, stamp("shared:5h", 5_000, base));

    const read = next.read(accountId);
    expect(Object.keys(read.evidence.evidence.windows)).toEqual(["shared:5h"]);
    expect(read.evidence.uncertain).toEqual({
      claude_usage: false,
      codex_usage: false,
    });
  });

  it.each(LEGACY_NAMES)(
    "(d) rolling back to the %s build and forward again converts only the accounts it touched",
    (name) => {
      const { database } = seeded();
      seed(database, otherAccountId);
      const untouchedBefore = evidenceRow(database, otherAccountId);

      const rolledBack = reopen(database);
      startLegacy(name, rolledBack);
      const build = legacy(name, rolledBack);
      build.put({ ...build.get(accountId), observedAt: 300 });
      build.put({ ...build.get(accountId), observedAt: 310 });
      build.put({ ...emptyQuota(thirdAccountId), observedAt: 320 });

      const touched = build.get(accountId);
      const rolledForward = reopen(rolledBack);
      expect(() => migrate(rolledForward, QUOTA_MIGRATIONS)).not.toThrow();
      const next = new QuotaStore(rolledForward);

      expectAllLegacy(next.read(accountId));
      expect(next.read(thirdAccountId).evidence.present).toBe(false);
      const untouched = next.read(otherAccountId);
      expect(untouched.evidence.matches).toBe(true);
      expect(untouched.evidence.uncertain).toEqual({
        claude_usage: false,
        codex_usage: false,
      });
      expect(untouched.evidence.evidence.windows["shared:5h"]).toMatchObject({
        utilizationAt: 1_000,
      });
      expect(evidenceRow(rolledForward, otherAccountId)).toEqual(
        untouchedBefore,
      );

      next.update(accountId, stamp("shared:5h", 7_000, touched));

      const read = next.read(accountId);
      expect(read.evidence.matches).toBe(true);
      expect(read.evidence.evidence.seq).toBe(2);
      expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
        utilizationAt: 7_000,
      });
      expect(
        read.evidence.evidence.windows["shared:7d"]?.utilizationAt,
      ).toBeNull();
      expect(read.evidence.evidence.classUncertain).toEqual({
        claude_usage: 2,
        codex_usage: 2,
      });
    },
  );

  it("(e) an older build deleting an account leaves orphan evidence the new build ignores", () => {
    const { database, next } = seeded();
    const old = legacy("old", database);
    const stored = evidenceRow(database)?.mutation ?? 0;
    old.remove(accountId);

    expect(next.read(accountId).evidence.present).toBe(false);
    expect(evidenceRow(database)).toBeDefined();

    old.put(base);

    expect(mutation(database)).toBe(stored + 2);
    const read = next.read(accountId);
    expect(read.evidence.present).toBe(true);
    expectAllLegacy(read);
  });

  it("(f) an older-build rejection between a new-build read and write is preserved", () => {
    const { database, next } = seeded();
    const observed = next.read(accountId);
    expect(observed.evidence.matches).toBe(true);
    expect(observed.quota.fiveHourStatus).toBe("allowed");

    const old = legacy("old", database);
    old.put({
      ...old.get(accountId),
      fiveHourUtilization: 1,
      fiveHourStatus: "rejected",
      observedAt: 150,
    });
    let seen: QuotaEvidenceCurrent | undefined;

    const written = next.update(accountId, (current) => {
      seen = current;
      return stamp("shared:7d", 9_000, (quota) => ({
        ...quota,
        sevenDayUtilization: 0.5,
      }))(current);
    });

    expect(seen?.quota.fiveHourUtilization).toBe(1);
    expect(seen?.quota.fiveHourStatus).toBe("rejected");
    expect(seen?.evidence.matches).toBe(false);
    expect(
      seen?.evidence.evidence.windows["shared:5h"]?.utilizationAt,
    ).toBeNull();
    expect(seen?.evidence.uncertain).toEqual({
      claude_usage: true,
      codex_usage: true,
    });
    expect(written).toMatchObject({
      fiveHourUtilization: 1,
      fiveHourStatus: "rejected",
      sevenDayUtilization: 0.5,
    });
    expect(old.get(accountId)).toMatchObject({
      fiveHourUtilization: 1,
      fiveHourStatus: "rejected",
      sevenDayUtilization: 0.5,
    });
    expect(next.read(accountId).evidence.matches).toBe(true);
  });

  it("(f) an older-build write that lands inside the update window cannot slip in", () => {
    const { database, next } = seeded();
    const blocked = legacy("old", open("pool.db", 0));
    let attempt: unknown;

    next.update(accountId, (current) => {
      try {
        blocked.put({
          ...current.quota,
          fiveHourUtilization: 1,
          fiveHourStatus: "rejected",
        });
      } catch (error) {
        attempt = error;
      }
      return stamp("shared:5h", 9_000)(current);
    });

    expect(attempt).toMatchObject({ code: "SQLITE_BUSY" });
    expect(next.get(accountId).fiveHourStatus).toBe("allowed");
    expect(next.read(accountId).evidence.matches).toBe(true);
    expect(mutation(database)).toBe(evidenceRow(database)?.mutation);
  });

  it.each(LEGACY_NAMES)(
    "(g) the %s build deleting and recreating the row with identical contents reads legacy",
    (name) => {
      const { database, next } = seeded();
      const build = legacy(name, database);
      const contents = build.get(accountId);
      build.remove(accountId);
      build.put(contents);

      expect(next.get(accountId)).toEqual(contents);
      expect(mutation(database)).toBe(
        (evidenceRow(database)?.mutation ?? 0) + 2,
      );
      expectAllLegacy(next.read(accountId));
    },
  );

  it.each(LEGACY_NAMES)(
    "(h) restoring the contents with a second %s-build write reads legacy",
    (name) => {
      const { database, next } = seeded();
      const build = legacy(name, database);
      const contents = build.get(accountId);
      build.put({ ...contents, fiveHourUtilization: 0.9 });
      build.put(contents);

      expect(next.get(accountId)).toEqual(contents);
      expectAllLegacy(next.read(accountId));
    },
  );

  it("(i) the old SELECT * reader and its strict row schema accept the new schema", () => {
    const { database, next } = seeded();
    const olderOnly = legacyMigrated("old", open("older-only.db"));

    expect(columns(database, "account_quota")).toEqual(
      columns(olderOnly, "account_quota"),
    );
    const old = legacy("old", database);
    expect(old.get(accountId).accountId).toBe(accountId);

    const before = mutation(database) ?? 0;
    old.put({ ...base, observedAt: 400 });
    expect(mutation(database)).toBe(before + 1);
    old.remove(accountId);
    expect(mutation(database)).toBe(before + 2);
    expect(old.get(accountId).observedAt).toBeNull();
    expect(next.read(accountId).evidence.present).toBe(false);
  });

  it("(j) the explicit-column build reads databases from the older and the new schema", () => {
    const olderOnly = legacyMigrated("old", open("older-only.db"));
    legacy("old", olderOnly).put(base);
    expect(legacy("a0", olderOnly).get(accountId).fiveHourUtilization).toBe(
      0.3,
    );

    const { database } = seeded();
    const a0 = legacy("a0", database);
    expect(a0.get(accountId).fiveHourUtilization).toBe(0.3);
    expect(a0.get(otherAccountId).observedAt).toBeNull();
  });

  it("(k) a database started by the older build first and migrated by the new build keeps its rows", () => {
    const database = legacyMigrated("a0");
    legacy("a0", database).put(base);

    migrate(database, QUOTA_MIGRATIONS);

    const next = new QuotaStore(database);
    expect(next.get(accountId)).toEqual(base);
    expect(mutation(database)).toBe(0);
    expect(next.read(accountId).evidence.present).toBe(false);
    next.update(accountId, stamp("shared:5h", 5_000));
    expect(next.read(accountId).evidence.matches).toBe(true);
  });
});
