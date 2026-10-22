import type Database from "better-sqlite3";
import type { LegacyMigrationChainEntry } from "./legacy-migration-chain.js";

export const MIGRATION_LEDGER_TABLE = "__bb_migration_ledger";
export const COMPAT_LOG_TABLE = "__drizzle_migrations";

export type MigrationLedgerHow =
  | "applied"
  | "mapped"
  | "mark-only"
  | "function"
  | `superseded-by:${string}`;

export interface MigrationLedgerRow {
  namespace: string;
  tag: string;
  sha256: string;
  how: string;
  appliedAt: number;
}

export interface CompatLogRow {
  createdAt: number | null;
  hash: string;
}

export interface ExpectedCompatPair {
  tag: string;
  createdAt: number;
  hash: string;
  compatibleHashes: readonly string[];
  publishedWhen: number | undefined;
}

export type CompatClassification =
  | { kind: "match"; hash: string }
  | { kind: "violation"; reason: "hash-mismatch" | "missing-created-at" };

export class MigrationStateUnknown extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = "MigrationStateUnknown";
    this.details = details;
  }
}

export function expectedCompatPair(
  legacy: LegacyMigrationChainEntry,
): ExpectedCompatPair {
  return {
    tag: legacy.tag,
    createdAt: legacy.when,
    hash: legacy.sha256,
    compatibleHashes: legacy.compatibleHashes,
    publishedWhen: legacy.publishedWhen,
  };
}

export function formatExpectedCompatPair(pair: ExpectedCompatPair): string {
  return `${pair.tag} (when=${pair.createdAt}, hash=${pair.hash})`;
}

export function classifyAgainstCompatLog(
  pair: ExpectedCompatPair,
  rows: readonly CompatLogRow[],
): CompatClassification {
  const sameCreatedAt = rows.filter((row) => row.createdAt === pair.createdAt);
  if (sameCreatedAt.some((row) => row.hash === pair.hash)) {
    return { kind: "match", hash: pair.hash };
  }
  const alternate = sameCreatedAt.find((row) =>
    pair.compatibleHashes.includes(row.hash),
  );
  if (alternate !== undefined) {
    return { kind: "match", hash: alternate.hash };
  }
  if (sameCreatedAt.length > 0 && pair.publishedWhen === pair.createdAt) {
    return { kind: "match", hash: pair.hash };
  }
  return {
    kind: "violation",
    reason: sameCreatedAt.length > 0 ? "hash-mismatch" : "missing-created-at",
  };
}

export function describeViolations(
  violations: ReadonlyArray<{
    pair: ExpectedCompatPair;
    reason: "hash-mismatch" | "missing-created-at";
  }>,
  heading: string,
): string {
  const missing = violations.filter(
    (violation) => violation.reason === "missing-created-at",
  );
  const mismatched = violations.filter(
    (violation) => violation.reason === "hash-mismatch",
  );
  return [
    heading,
    missing.length > 0
      ? `Missing applied migration timestamps: ${missing
          .map((violation) => formatExpectedCompatPair(violation.pair))
          .join("; ")}.`
      : null,
    mismatched.length > 0
      ? `Mismatched applied migration hashes: ${mismatched
          .map((violation) => formatExpectedCompatPair(violation.pair))
          .join("; ")}.`
      : null,
    missing.length > 0
      ? "Missing timestamps usually mean Drizzle skipped a migration because its journal timestamp is not newer than the latest applied migration."
      : null,
    mismatched.length > 0
      ? "Hash mismatches mean the migration ledger row exists at that timestamp but does not match the current migration file."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

export function ledgerTableExists(sqlite: Database.Database): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATION_LEDGER_TABLE) !== undefined
  );
}

export function compatLogExists(sqlite: Database.Database): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(COMPAT_LOG_TABLE) !== undefined
  );
}

export function ensureLedgerTable(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (namespace TEXT NOT NULL, tag TEXT NOT NULL, sha256 TEXT NOT NULL, how TEXT NOT NULL, applied_at INTEGER NOT NULL, UNIQUE (namespace, tag))`,
  );
}

export function ensureCompatLog(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${COMPAT_LOG_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
}

export function readLedger(sqlite: Database.Database): MigrationLedgerRow[] {
  if (!ledgerTableExists(sqlite)) return [];
  return sqlite
    .prepare(
      `SELECT namespace, tag, sha256, how, applied_at AS appliedAt FROM ${MIGRATION_LEDGER_TABLE} ORDER BY rowid`,
    )
    .all() as MigrationLedgerRow[];
}

export function readCompatLog(sqlite: Database.Database): CompatLogRow[] {
  if (!compatLogExists(sqlite)) return [];
  return sqlite
    .prepare(
      `SELECT created_at AS createdAt, hash FROM ${COMPAT_LOG_TABLE} ORDER BY id`,
    )
    .all() as CompatLogRow[];
}

export function insertLedgerRow(
  sqlite: Database.Database,
  row: Omit<MigrationLedgerRow, "appliedAt">,
  now: number,
): void {
  const existing = sqlite
    .prepare(
      `SELECT 1 FROM ${MIGRATION_LEDGER_TABLE} WHERE namespace = ? AND tag = ?`,
    )
    .get(row.namespace, row.tag);
  if (existing !== undefined) {
    throw new MigrationStateUnknown(
      `Migration ledger already holds ${row.namespace}:${row.tag}`,
    );
  }
  sqlite
    .prepare(
      `INSERT INTO ${MIGRATION_LEDGER_TABLE} (namespace, tag, sha256, how, applied_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.namespace, row.tag, row.sha256, row.how, now);
}

export function insertCompatRow(
  sqlite: Database.Database,
  pair: { createdAt: number; hash: string },
): void {
  const existing = sqlite
    .prepare(`SELECT 1 FROM ${COMPAT_LOG_TABLE} WHERE created_at = ?`)
    .get(pair.createdAt);
  if (existing !== undefined) return;
  sqlite
    .prepare(`INSERT INTO ${COMPAT_LOG_TABLE} (hash, created_at) VALUES (?, ?)`)
    .run(pair.hash, pair.createdAt);
}

export function readMaxCompatCreatedAt(
  sqlite: Database.Database,
): number | null {
  if (!compatLogExists(sqlite)) return null;
  const row = sqlite
    .prepare(`SELECT MAX(created_at) AS createdAt FROM ${COMPAT_LOG_TABLE}`)
    .get() as { createdAt: number | null } | undefined;
  return row?.createdAt ?? null;
}
