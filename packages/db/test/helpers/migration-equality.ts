import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const MODULUS = 1n << 128n;

export interface TableDigest {
  count: number;
  digest: string;
}

export interface DatabaseDescription {
  schema: string[];
  sequences: Array<[string, string]>;
  tables: Record<string, TableDigest>;
  ledger: TableDigest;
}

export interface DescribeOptions {
  includeRowid?: boolean;
}

function frame(tag: string, bytes: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([Buffer.from(tag, "ascii"), length, bytes]);
}

function encodeValue(value: unknown): Buffer {
  if (value === null || value === undefined) return frame("n", Buffer.alloc(0));
  if (typeof value === "bigint" || typeof value === "number") {
    if (typeof value === "number" && !Number.isInteger(value)) {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value);
      return frame("r", bytes);
    }
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(BigInt(value));
    return frame("i", bytes);
  }
  if (typeof value === "string") return frame("t", Buffer.from(value, "utf8"));
  if (Buffer.isBuffer(value)) return frame("b", value);
  throw new Error(`Unsupported SQLite value type: ${typeof value}`);
}

export function rowHash(values: readonly unknown[]): bigint {
  const hash = createHash("sha256");
  for (const value of values) hash.update(encodeValue(value));
  return BigInt(`0x${hash.digest("hex").slice(0, 32)}`);
}

export function combineRowHashes(hashes: Iterable<bigint>): TableDigest {
  let sum = 0n;
  let count = 0;
  for (const hash of hashes) {
    sum = (sum + hash) % MODULUS;
    count += 1;
  }
  return { count, digest: sum.toString(16).padStart(32, "0") };
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function listUserTables(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => name !== "__drizzle_migrations");
}

function isShadowTable(sqlite: Database.Database, name: string): boolean {
  return (
    (
      sqlite
        .prepare(
          "SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ?",
        )
        .get(name) as { type: string } | undefined
    )?.type === "shadow"
  );
}

export function digestTable(
  sqlite: Database.Database,
  table: string,
  options: DescribeOptions = {},
): TableDigest {
  const columns = (
    sqlite
      .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0")
      .all(table) as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
  const projection = [
    ...(options.includeRowid ? ["rowid"] : []),
    ...columns.map(quoteIdentifier),
  ].join(", ");
  const statement = sqlite
    .prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`)
    .raw(true)
    .safeIntegers(true);
  return combineRowHashes(
    (function* () {
      for (const row of statement.iterate()) yield rowHash(row as unknown[]);
    })(),
  );
}

function normalizeSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

export function describeSchema(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY type, name",
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>
  ).map(
    (row) => `${row.type}|${row.name}|${row.tbl_name}|${normalizeSql(row.sql)}`,
  );
}

export function describeSequences(
  sqlite: Database.Database,
): Array<[string, string]> {
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  if (!exists) return [];
  const merged = new Map<string, bigint>();
  for (const row of sqlite
    .prepare("SELECT name, seq FROM sqlite_sequence")
    .safeIntegers(true)
    .all() as Array<{ name: string; seq: bigint }>) {
    const previous = merged.get(row.name);
    if (previous === undefined || row.seq > previous)
      merged.set(row.name, row.seq);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, seq]) => [name, seq.toString()]);
}

export function describeLedger(sqlite: Database.Database): TableDigest {
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
    .get();
  if (!exists) return { count: 0, digest: "0".repeat(32) };
  return digestTable(sqlite, "__drizzle_migrations");
}

export function describeDatabase(
  sqlite: Database.Database,
  options: DescribeOptions = {},
): DatabaseDescription {
  const tables: Record<string, TableDigest> = {};
  for (const table of listUserTables(sqlite)) {
    if (isShadowTable(sqlite, table)) continue;
    tables[table] = digestTable(sqlite, table, options);
  }
  return {
    schema: describeSchema(sqlite),
    sequences: describeSequences(sqlite),
    tables,
    ledger: describeLedger(sqlite),
  };
}

export function contentOnly(
  description: DatabaseDescription,
): Omit<DatabaseDescription, "ledger"> {
  return {
    schema: description.schema,
    sequences: description.sequences,
    tables: description.tables,
  };
}

export function schemaFingerprint(description: DatabaseDescription): string {
  return createHash("sha256")
    .update(JSON.stringify(description.schema))
    .digest("hex");
}

export function diffDescriptions(
  expected: Omit<DatabaseDescription, "ledger">,
  actual: Omit<DatabaseDescription, "ledger">,
): string[] {
  const differences: string[] = [];
  const expectedSchema = new Set(expected.schema);
  const actualSchema = new Set(actual.schema);
  for (const line of expectedSchema)
    if (!actualSchema.has(line)) differences.push(`schema missing: ${line}`);
  for (const line of actualSchema)
    if (!expectedSchema.has(line)) differences.push(`schema extra: ${line}`);
  if (JSON.stringify(expected.sequences) !== JSON.stringify(actual.sequences))
    differences.push("sqlite_sequence state differs");
  const names = new Set([
    ...Object.keys(expected.tables),
    ...Object.keys(actual.tables),
  ]);
  for (const name of [...names].sort()) {
    const left = expected.tables[name];
    const right = actual.tables[name];
    if (!left) differences.push(`table extra: ${name}`);
    else if (!right) differences.push(`table missing: ${name}`);
    else if (left.count !== right.count || left.digest !== right.digest)
      differences.push(
        `table differs: ${name} (${left.count} rows ${left.digest} vs ${right.count} rows ${right.digest})`,
      );
  }
  return differences;
}
