import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  windowEvidenceSchema,
  type AccountQuota,
  type EvidenceWriter,
} from "./contracts.js";
import {
  emptyQuota,
  LEGACY_MIGRATION_COUNT,
  LEGACY_QUOTA_COLUMNS,
  LegacyQuotaStore,
} from "./fixtures/legacy-quota-builds.js";
import { QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const accountId = "33333333-3333-4333-8333-333333333333";
const otherAccountId = "44444444-4444-4444-8444-444444444444";

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
  for (const database of databases) database.close();
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

function legacyMigrated(database = open()): Database.Database {
  migrate(database, QUOTA_MIGRATIONS.slice(0, LEGACY_MIGRATION_COUNT));
  return database;
}

function stamp(key: string, at: number): EvidenceWriter {
  return (view, seq) => ({
    windows: {
      ...view.evidence.windows,
      [key]: {
        ...windowEvidenceSchema.parse({}),
        ...view.evidence.windows[key],
        utilizationAt: at,
        utilizationSeq: seq,
        reportedAt: at,
        lastSeq: seq,
      },
    },
    removed: view.evidence.removed,
    classUncertain: view.evidence.classUncertain,
    snapshotSeq: view.evidence.snapshotSeq,
  });
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

const base = quotaWith({
  fiveHourUtilization: 0.3,
  fiveHourResetAt: 4_102_452_000_000,
  fiveHourStatus: "allowed",
  sevenDayUtilization: 0.4,
  sevenDayResetAt: 4_102_452_000_000,
  sevenDayStatus: "allowed",
  observedAt: 100,
});

describe("quota evidence store", () => {
  it("records the evidence migration as one appended entry", () => {
    expect(QUOTA_MIGRATIONS).toHaveLength(LEGACY_MIGRATION_COUNT + 1);
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
    const database = legacyMigrated();
    const old = new LegacyQuotaStore(database, "old");
    old.put(base);
    old.put({ ...base, accountId: otherAccountId });
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
    quotas.put(base, stamp("shared:5h", 1_000));

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

  it("rolls both rows back when the evidence writer throws", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(base, stamp("shared:5h", 1_000));
    const before = mutation(database);

    expect(() =>
      quotas.put({ ...base, fiveHourUtilization: 0.9 }, () => {
        throw new Error("writer failed");
      }),
    ).toThrow("writer failed");

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

    expect(() => quotas.put(base, stamp("shared:5h", 1_000))).toThrow(
      "blocked",
    );

    expect(evidenceRow(database)).toBeUndefined();
    expect(mutation(database)).toBeUndefined();
  });

  it("serializes writers: another connection is locked out mid-transaction", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    const other = new LegacyQuotaStore(open("pool.db", 0), "old");
    let attempt: unknown;

    quotas.put(base, (view, seq) => {
      try {
        other.put({ ...base, fiveHourUtilization: 0.99 });
      } catch (error) {
        attempt = error;
      }
      return stamp("shared:5h", 1_000)(view, seq);
    });

    expect(attempt).toMatchObject({ code: "SQLITE_BUSY" });
    expect(quotas.read(accountId).evidence.matches).toBe(true);
    expect(quotas.get(accountId).fiveHourUtilization).toBe(0.3);
  });

  it("drops only freshness stamps on a counter mismatch", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(base, (view, seq) => {
      const document = stamp("shared:5h", 1_000)(view, seq);
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
      return document;
    });
    new LegacyQuotaStore(database, "old").put({ ...base, observedAt: 200 });

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
    quotas.put(base, stamp("shared:5h", 1_000));
    database.prepare("DELETE FROM account_quota_mutation").run();

    const read = quotas.read(accountId);
    expect(read.evidence.matches).toBe(false);
    expect(read.evidence.uncertain.claude_usage).toBe(true);
    expect(read.evidence.evidence.windows["shared:5h"]?.utilizationAt).toBeNull();
  });

  it("reads rows without an evidence row as legacy, not uncertain", () => {
    const database = migrated();
    new LegacyQuotaStore(database, "old").put(base);

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
    quotas.put(base, stamp("shared:5h", 1_000));
    database.prepare("DELETE FROM account_quota").run();

    const read = quotas.read(accountId);
    expect(read.evidence.present).toBe(false);
    expect(read.evidence.evidence.windows).toEqual({});
  });

  it("treats an unreadable evidence document as missing", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(base);
    database
      .prepare(
        "INSERT INTO account_quota_evidence VALUES (?, 3, 1, 'not json')",
      )
      .run(accountId);

    expect(quotas.read(accountId).evidence.present).toBe(false);
  });

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
      .prepare(
        "INSERT INTO account_quota_evidence VALUES (?, 4, ?, ?)",
      )
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

  it("converts a mismatched row before the writer runs", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(base, stamp("shared:5h", 1_000));
    new LegacyQuotaStore(database, "old").put({ ...base, observedAt: 200 });
    let seen: Parameters<EvidenceWriter>[0] | undefined;

    quotas.put(base, (view, seq) => {
      seen = view;
      return stamp("shared:7d", 2_000)(view, seq);
    });

    expect(seen?.matches).toBe(false);
    expect(seen?.uncertain).toEqual({ claude_usage: true, codex_usage: true });
    expect(seen?.evidence.windows["shared:5h"]).toMatchObject({
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
    expect(read.evidence.evidence.windows["shared:5h"]?.utilizationAt).toBeNull();
  });

  it("keeps a reduced evidence row and the counter when an account is deleted", () => {
    const database = migrated();
    const quotas = new QuotaStore(database);
    quotas.put(
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
      (view, seq) => ({
        ...stamp("shared:5h", 1_000)(view, seq),
        snapshotSeq: { claude_usage: 1, codex_usage: null },
      }),
    );

    quotas.remove(accountId);

    expect(quotas.get(accountId).observedAt).toBeNull();
    expect(mutation(database)).toBe(2);
    const row = evidenceRow(database);
    expect(row).toMatchObject({ seq: 2, mutation: 2 });
    const document = JSON.parse(row?.evidence_json ?? "{}");
    expect(document.windows).toEqual({});
    expect(document.snapshotSeq).toEqual({ claude_usage: 1, codex_usage: null });
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
    quotas.put(base, (view, seq) => ({
      ...stamp("shared:5h", 1_000)(view, seq),
      snapshotSeq: { claude_usage: 1, codex_usage: null },
    }));
    quotas.remove(accountId);

    quotas.put(base, stamp("shared:5h", 3_000));

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

describe("cross-version quota evidence", () => {
  function stores(database: Database.Database) {
    return {
      next: new QuotaStore(database),
      old: new LegacyQuotaStore(database, "old"),
      a0: new LegacyQuotaStore(database, "a0"),
    };
  }

  function seeded() {
    const database = migrated();
    const built = stores(database);
    built.next.put(base, (view, seq) => {
      const first = stamp("shared:5h", 1_000)(view, seq);
      return stamp("shared:7d", 1_000)(
        { ...view, evidence: { ...view.evidence, windows: first.windows } },
        seq,
      );
    });
    return { database, ...built };
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

  it("(a) an older build reads and starts up on a database migrated by the new build", () => {
    const { database, old } = seeded();

    expect(() =>
      migrate(database, QUOTA_MIGRATIONS.slice(0, LEGACY_MIGRATION_COUNT)),
    ).not.toThrow();
    const recorded = database
      .prepare("SELECT COUNT(*) AS count FROM _bb_migrations")
      .get() as { count: number };
    expect(recorded.count).toBe(LEGACY_MIGRATION_COUNT + 1);
    expect(old.get(accountId)).toMatchObject({
      accountId,
      fiveHourUtilization: 0.3,
      sevenDayUtilization: 0.4,
      observedAt: 100,
    });
    expect(old.get(otherAccountId).observedAt).toBeNull();
  });

  it.each([
    ["header write", { fiveHourUtilization: 0.35, observedAt: 150 }],
    ["usage poll", { sevenDayUtilization: 0.45, observedAt: 160 }],
    ["hold", { heldUntil: 4_102_452_000_000 }],
    ["error write", { error: "upstream failed" }],
  ] as const)(
    "(b) an older build's %s leaves the new build reading every window as legacy",
    (_name, change) => {
      const { database, next, old } = seeded();
      old.put({ ...old.get(accountId), ...change });

      expect(mutation(database)).toBe((evidenceRow(database)?.mutation ?? 0) + 1);
      const read = next.read(accountId);
      expectAllLegacy(read);
      expect(Object.keys(read.evidence.evidence.windows).sort()).toEqual([
        "shared:5h",
        "shared:7d",
      ]);
    },
  );

  it("(c) new-build writes after an older build evidence only the windows it reports", () => {
    const { database, next, old } = seeded();
    old.put({ ...old.get(accountId), fiveHourUtilization: 0.5 });
    next.put(old.get(accountId), stamp("shared:5h", 5_000));

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
    const { next, old } = stores(database);
    old.put(base);
    next.put(base, stamp("shared:5h", 5_000));

    const read = next.read(accountId);
    expect(Object.keys(read.evidence.evidence.windows)).toEqual(["shared:5h"]);
    expect(read.evidence.uncertain).toEqual({
      claude_usage: false,
      codex_usage: false,
    });
  });

  it("(d) rolling back to the older build and forward again converts the evidence", () => {
    const { database, next, old } = seeded();
    old.put({ ...old.get(accountId), observedAt: 300 });
    migrate(database, QUOTA_MIGRATIONS.slice(0, LEGACY_MIGRATION_COUNT));
    old.put({ ...old.get(accountId), observedAt: 310 });
    migrate(database, QUOTA_MIGRATIONS);

    expectAllLegacy(next.read(accountId));
    next.put(old.get(accountId), stamp("shared:5h", 7_000));

    const read = next.read(accountId);
    expect(read.evidence.matches).toBe(true);
    expect(read.evidence.evidence.seq).toBe(2);
    expect(read.evidence.evidence.windows["shared:5h"]).toMatchObject({
      utilizationAt: 7_000,
    });
    expect(read.evidence.evidence.windows["shared:7d"]?.utilizationAt).toBeNull();
    expect(read.evidence.evidence.classUncertain).toEqual({
      claude_usage: 2,
      codex_usage: 2,
    });
  });

  it("(e) an older build deleting an account leaves orphan evidence the new build ignores", () => {
    const { database, next, old } = seeded();
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

  it("(f) an older-build write between a new-build read and write is converted first", () => {
    const { next, old } = seeded();
    const observed = next.read(accountId);
    expect(observed.evidence.matches).toBe(true);

    old.put({ ...old.get(accountId), fiveHourUtilization: 0.8 });
    let seen: Parameters<EvidenceWriter>[0] | undefined;
    next.put(old.get(accountId), (view, seq) => {
      seen = view;
      return stamp("shared:5h", 9_000)(view, seq);
    });

    expect(seen?.matches).toBe(false);
    expect(seen?.evidence.windows["shared:5h"]?.utilizationAt).toBeNull();
    expect(seen?.uncertain).toEqual({ claude_usage: true, codex_usage: true });
    expect(next.read(accountId).evidence.matches).toBe(true);
  });

  it("(g) deleting and recreating the row with identical contents reads legacy", () => {
    const { database, next, old } = seeded();
    const contents = old.get(accountId);
    old.remove(accountId);
    old.put(contents);

    expect(next.get(accountId)).toEqual(contents);
    expect(mutation(database)).toBe((evidenceRow(database)?.mutation ?? 0) + 2);
    expectAllLegacy(next.read(accountId));
  });

  it("(h) restoring the contents with a second older-build write reads legacy", () => {
    const { next, old } = seeded();
    const contents = old.get(accountId);
    old.put({ ...contents, fiveHourUtilization: 0.9 });
    old.put(contents);

    expect(next.get(accountId)).toEqual(contents);
    expectAllLegacy(next.read(accountId));
  });

  it("(i) strict and explicit-column readers work with the counter table and triggers", () => {
    const { database, next, old, a0 } = seeded();

    const unrestricted = database
      .prepare("SELECT * FROM account_quota WHERE account_id = ?")
      .get(accountId) as Record<string, unknown>;
    expect(Object.keys(unrestricted).sort()).toEqual(
      [...LEGACY_QUOTA_COLUMNS].sort(),
    );
    expect(old.get(accountId).accountId).toBe(accountId);
    expect(a0.get(accountId).accountId).toBe(accountId);

    const before = mutation(database) ?? 0;
    old.put({ ...base, observedAt: 400 });
    expect(mutation(database)).toBe(before + 1);
    old.remove(accountId);
    expect(mutation(database)).toBe(before + 2);
    expect(old.get(accountId).observedAt).toBeNull();
    expect(next.read(accountId).evidence.present).toBe(false);
  });

  it("(j) the explicit-column build reads databases from the older and the new schema", () => {
    const legacyDatabase = legacyMigrated(open("legacy.db"));
    const legacyStores = stores(legacyDatabase);
    legacyStores.old.put(base);
    expect(legacyStores.a0.get(accountId).fiveHourUtilization).toBe(0.3);

    const { a0 } = seeded();
    expect(a0.get(accountId).fiveHourUtilization).toBe(0.3);
    expect(a0.get(otherAccountId).observedAt).toBeNull();
  });
});
