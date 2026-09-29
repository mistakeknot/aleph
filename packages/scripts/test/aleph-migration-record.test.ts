import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareRecords,
  computeMigrationRecord,
  deriveDelivery,
  journalSha256,
  parseQualifiedPairs,
  qualifyPair,
  recordSha256,
  runBackCompatCheck,
  type MigrationRecord,
  type QualifiedPairs,
} from "../src/lib/aleph-migration-record.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function cloneRecord(record: MigrationRecord): MigrationRecord {
  return structuredClone(record);
}

function makePredecessorRoot(): string {
  const root = scratch("aleph-predecessor-");
  const dbDir = join(root, "packages", "db");
  mkdirSync(dbDir, { recursive: true });
  cpSync(join(repoRoot, "packages", "db", "src"), join(dbDir, "src"), {
    recursive: true,
  });
  cpSync(join(repoRoot, "packages", "db", "drizzle"), join(dbDir, "drizzle"), {
    recursive: true,
  });
  cpSync(
    join(repoRoot, "packages", "db", "package.json"),
    join(dbDir, "package.json"),
  );
  symlinkSync(
    join(repoRoot, "packages", "db", "node_modules"),
    join(dbDir, "node_modules"),
    "dir",
  );
  cpSync(
    join(repoRoot, "packages", "host-daemon-contract", "src"),
    join(root, "packages", "host-daemon-contract", "src"),
    { recursive: true },
  );
  const journalPath = join(dbDir, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const dropped = journal.entries.pop();
  if (dropped === undefined) {
    throw new Error("empty journal");
  }
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  rmSync(join(dbDir, "drizzle", `${dropped.tag}.sql`));
  return root;
}

describe("computeMigrationRecord", () => {
  it("captures journal entries, per-file SQL hashes, snapshot hash, protocol and wire contract", () => {
    const record = computeMigrationRecord({ repoRoot });

    expect(record.db.entries.length).toBeGreaterThan(100);
    expect(record.db.entries[0]).toEqual({
      idx: 0,
      tag: "0000_baseline",
      when: 1778891867195,
      breakpoints: true,
    });
    expect(record.db.sqlSha256).toHaveLength(record.db.entries.length);
    expect(record.db.sqlSha256[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.db.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.connectDb).toBeNull();
    expect(record.hostDaemonProtocolVersion).toBeGreaterThan(0);
    expect(record.wireContractSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("includes the connect-db journal only when it is bundled", () => {
    const record = computeMigrationRecord({
      repoRoot,
      includeConnectDb: true,
    });

    expect(record.connectDb?.entries[0]?.tag).toBe("0000_init");
  });

  it("is deterministic", () => {
    expect(recordSha256(computeMigrationRecord({ repoRoot }))).toBe(
      recordSha256(computeMigrationRecord({ repoRoot })),
    );
  });
});

describe("compareRecords", () => {
  const base = computeMigrationRecord({ repoRoot });

  it("reports identical records", () => {
    expect(compareRecords(base, cloneRecord(base))).toEqual({
      identical: true,
      differences: [],
    });
  });

  it.each([
    [
      "an added migration",
      (record: MigrationRecord) => {
        record.db.entries.pop();
        record.db.sqlSha256.pop();
      },
      "db.entries",
    ],
    [
      "a changed journal timestamp",
      (record: MigrationRecord) => {
        const entry = record.db.entries[3];
        if (entry) entry.when += 1;
      },
      "db.entries",
    ],
    [
      "a changed SQL file",
      (record: MigrationRecord) => {
        const entry = record.db.sqlSha256[5];
        if (entry) entry.sha256 = "0".repeat(64);
      },
      "db.sqlSha256",
    ],
    [
      "a changed snapshot",
      (record: MigrationRecord) => {
        record.db.snapshotSha256 = "1".repeat(64);
      },
      "db.snapshotSha256",
    ],
    [
      "a protocol bump",
      (record: MigrationRecord) => {
        record.hostDaemonProtocolVersion += 1;
      },
      "hostDaemonProtocolVersion",
    ],
    [
      "a wire contract change",
      (record: MigrationRecord) => {
        record.wireContractSha256 = "2".repeat(64);
      },
      "wireContractSha256",
    ],
    [
      "a connect-db journal appearing",
      (record: MigrationRecord) => {
        record.connectDb = computeMigrationRecord({
          repoRoot,
          includeConnectDb: true,
        }).connectDb;
      },
      "connectDb",
    ],
  ])("flags %s", (_name, mutate, field) => {
    const changed = cloneRecord(base);
    mutate(changed);

    const result = compareRecords(base, changed);

    expect(result.identical).toBe(false);
    expect(result.differences.join("\n")).toContain(field);
    expect(recordSha256(changed)).not.toBe(recordSha256(base));
  });

  it("journalSha256 ignores protocol and wire fields", () => {
    const changed = cloneRecord(base);
    changed.hostDaemonProtocolVersion += 1;
    changed.wireContractSha256 = "3".repeat(64);

    expect(journalSha256(changed)).toBe(journalSha256(base));
  });
});

describe("parseQualifiedPairs", () => {
  it("accepts the checked-in file", () => {
    const parsed = parseQualifiedPairs(
      JSON.parse(
        readFileSync(join(repoRoot, "packages/scripts/qualified-pairs.json"), {
          encoding: "utf8",
        }),
      ),
    );

    expect(parsed.schema).toBe(1);
    expect(parsed.pairs).toEqual([]);
  });

  it.each([
    ["a non-object", null],
    ["a wrong schema", { schema: 2, pairs: [] }],
    ["a missing pairs array", { schema: 1 }],
    [
      "a pair without reverse-test evidence",
      {
        schema: 1,
        pairs: [
          {
            predecessor: { version: "a", recordSha256: "x" },
            successor: { version: "b", recordSha256: "y" },
          },
        ],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseQualifiedPairs(value)).toThrow();
  });
});

describe("deriveDelivery", () => {
  const predecessor = computeMigrationRecord({ repoRoot });
  const successor = cloneRecord(predecessor);
  successor.hostDaemonProtocolVersion += 1;
  const emptyPairs: QualifiedPairs = { schema: 1, pairs: [] };

  function pairsFor(fresh: boolean, afterReadyWrite: boolean): QualifiedPairs {
    return {
      schema: 1,
      pairs: [
        {
          predecessor: {
            version: "0.5.0",
            recordSha256: recordSha256(predecessor),
          },
          successor: {
            version: "0.5.1",
            recordSha256: recordSha256(successor),
          },
          evidence: { backCompat: { fresh, afterReadyWrite } },
        },
      ],
    };
  }

  it("ships auto for identical records, with back_compat by construction", () => {
    expect(
      deriveDelivery({
        predecessor,
        successor: cloneRecord(predecessor),
        pairs: emptyPairs,
      }),
    ).toEqual({ delivery: "auto", backCompat: true, reason: "identical" });
  });

  it("ships manual for a differing record with no qualified pair", () => {
    expect(
      deriveDelivery({ predecessor, successor, pairs: emptyPairs }),
    ).toEqual({
      delivery: "manual",
      backCompat: false,
      reason: "unqualified-difference",
    });
  });

  it("ships auto for a qualified pair whose evidence covers both reverse-test cases", () => {
    expect(
      deriveDelivery({ predecessor, successor, pairs: pairsFor(true, true) }),
    ).toEqual({
      delivery: "auto",
      backCompat: true,
      reason: "qualified-pair",
    });
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    "ships manual when reverse-test evidence is incomplete (fresh=%s, afterReadyWrite=%s)",
    (fresh, afterReadyWrite) => {
      expect(
        deriveDelivery({
          predecessor,
          successor,
          pairs: pairsFor(fresh, afterReadyWrite),
        }),
      ).toEqual({
        delivery: "manual",
        backCompat: false,
        reason: "incomplete-back-compat-evidence",
      });
    },
  );

  it("does not apply a pair recorded for a different successor record", () => {
    const other = cloneRecord(successor);
    other.wireContractSha256 = "4".repeat(64);

    expect(
      deriveDelivery({
        predecessor,
        successor: other,
        pairs: pairsFor(true, true),
      }).delivery,
    ).toBe("manual");
  });

  it("ships manual when there is no predecessor", () => {
    expect(
      deriveDelivery({ predecessor: null, successor, pairs: emptyPairs }),
    ).toEqual({
      delivery: "manual",
      backCompat: false,
      reason: "no-predecessor",
    });
  });
});

describe("runBackCompatCheck on the actual successor DB", () => {
  it("predecessor opens the successor DB fresh and after a ready write", async () => {
    const predecessorRoot = makePredecessorRoot();

    const result = await runBackCompatCheck({
      predecessorRoot,
      successorRoot: repoRoot,
      workDir: scratch("aleph-back-compat-"),
    });

    expect(result.fresh).toEqual({ ok: true, failures: [] });
    expect(result.afterReadyWrite).toEqual({ ok: true, failures: [] });
    expect(result.backCompat).toBe(true);
    const successorEntries = computeMigrationRecord({ repoRoot }).db.entries;
    const predecessorEntries = computeMigrationRecord({
      repoRoot: predecessorRoot,
    }).db.entries;
    expect(successorEntries.length).toBe(predecessorEntries.length + 1);
    expect(result.successorAppliedMigrations).toBe(successorEntries.length);
    expect(result.predecessorAppliedMigrations).toBe(
      result.successorAppliedMigrations,
    );
  }, 120_000);

  it("fails when the successor schema is not readable by the predecessor", async () => {
    const predecessorRoot = makePredecessorRoot();

    const result = await runBackCompatCheck({
      predecessorRoot,
      successorRoot: repoRoot,
      workDir: scratch("aleph-back-compat-neg-"),
      successorSchemaSabotage:
        "DROP INDEX pending_interactions_provider_request_idx",
    });

    expect(result.backCompat).toBe(false);
    expect(result.fresh.ok).toBe(false);
    expect(result.fresh.failures.join("\n")).toContain("pending_interactions");
  }, 120_000);

  it("qualifyPair only records a pair when both reverse-test cases pass", async () => {
    const predecessorRoot = makePredecessorRoot();
    const passing = await runBackCompatCheck({
      predecessorRoot,
      successorRoot: repoRoot,
      workDir: scratch("aleph-back-compat-q-"),
    });
    const predecessor = computeMigrationRecord({ repoRoot: predecessorRoot });
    const successor = computeMigrationRecord({ repoRoot });

    expect(
      qualifyPair({
        predecessor: { version: "0.5.0", record: predecessor },
        successor: { version: "0.5.1", record: successor },
        check: passing,
      }),
    ).toEqual({
      predecessor: {
        version: "0.5.0",
        recordSha256: recordSha256(predecessor),
      },
      successor: { version: "0.5.1", recordSha256: recordSha256(successor) },
      evidence: { backCompat: { fresh: true, afterReadyWrite: true } },
    });
    expect(() =>
      qualifyPair({
        predecessor: { version: "0.5.0", record: predecessor },
        successor: { version: "0.5.1", record: successor },
        check: {
          ...passing,
          afterReadyWrite: { ok: false, failures: ["boom"] },
          backCompat: false,
        },
      }),
    ).toThrow(/back_compat/u);
  }, 120_000);
  it("binds the reverse-check evidence to the records it was run against", async () => {
    const predecessorRoot = makePredecessorRoot();
    const check = await runBackCompatCheck({
      predecessorRoot,
      successorRoot: repoRoot,
      workDir: scratch("aleph-back-compat-bind-"),
    });
    const predecessor = computeMigrationRecord({ repoRoot: predecessorRoot });
    const successor = computeMigrationRecord({ repoRoot });

    expect(check.predecessorRecordSha256).toBe(recordSha256(predecessor));
    expect(check.successorRecordSha256).toBe(recordSha256(successor));

    const otherSuccessor = cloneRecord(successor);
    otherSuccessor.hostDaemonProtocolVersion += 1;
    const otherPredecessor = cloneRecord(predecessor);
    otherPredecessor.wireContractSha256 = "5".repeat(64);

    expect(() =>
      qualifyPair({
        predecessor: { version: "0.5.0", record: predecessor },
        successor: { version: "0.5.1", record: otherSuccessor },
        check,
      }),
    ).toThrow(/successor/u);
    expect(() =>
      qualifyPair({
        predecessor: { version: "0.5.0", record: otherPredecessor },
        successor: { version: "0.5.1", record: successor },
        check,
      }),
    ).toThrow(/predecessor/u);

    const qualified = qualifyPair({
      predecessor: { version: "0.5.0", record: predecessor },
      successor: { version: "0.5.1", record: successor },
      check,
    });
    expect(
      deriveDelivery({
        predecessor,
        successor: otherSuccessor,
        pairs: { schema: 1, pairs: [qualified] },
      }),
    ).toEqual({
      delivery: "manual",
      backCompat: false,
      reason: "unqualified-difference",
    });
  }, 120_000);
});
