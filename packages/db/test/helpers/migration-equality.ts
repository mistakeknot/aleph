import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const MODULUS = 1n << 128n;

export interface TableDigest {
  count: number;
  digest: string;
}

export interface DatabaseDescription {
  schema: string[];
  pragmas: Record<string, string>;
  sequences: Array<[string, string]>;
  tables: Record<string, TableDigest>;
  ledger: TableDigest;
  ledgerSchema: string[];
}

export interface DescribeOptions {
  ignoreRowid?: boolean;
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function frame(tag: string, bytes: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([Buffer.from(tag, "ascii"), length, bytes]);
}

interface TextBytes {
  textBytes: Buffer;
}

function isTextBytes(value: unknown): value is TextBytes {
  return (
    typeof value === "object" &&
    value !== null &&
    "textBytes" in value &&
    Buffer.isBuffer(value.textBytes)
  );
}

function encodeValue(value: unknown): Buffer {
  if (value === null || value === undefined) return frame("n", Buffer.alloc(0));
  if (typeof value === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX)
      throw new Error(`INTEGER outside the signed 64-bit range: ${value}`);
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(value);
    return frame("i", bytes);
  }
  if (typeof value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return frame("r", bytes);
  }
  if (typeof value === "string") return frame("t", Buffer.from(value, "utf8"));
  if (Buffer.isBuffer(value)) return frame("b", value);
  if (isTextBytes(value)) return frame("t", value.textBytes);
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

function isWithoutRowid(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  return /\)\s*(?:,\s*STRICT\s*,\s*)?WITHOUT\s+ROWID/i.test(row?.sql ?? "");
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
  const withRowid = !options.ignoreRowid && !isWithoutRowid(sqlite, table);
  const projection = [
    ...(withRowid ? ["rowid"] : []),
    ...columns.flatMap((column) => {
      const quoted = quoteIdentifier(column);
      return [
        quoted,
        `CASE WHEN typeof(${quoted}) = 'text' THEN CAST(${quoted} AS BLOB) END`,
      ];
    }),
  ].join(", ");
  const statement = sqlite
    .prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`)
    .raw(true)
    .safeIntegers(true);
  return combineRowHashes(
    (function* () {
      const lead = withRowid ? 1 : 0;
      for (const row of statement.iterate() as Iterable<unknown[]>) {
        const values: unknown[] = row.slice(0, lead);
        for (let index = lead; index < row.length; index += 2) {
          const raw = row[index + 1];
          values.push(Buffer.isBuffer(raw) ? { textBytes: raw } : row[index]);
        }
        yield rowHash(values);
      }
    })(),
  );
}

const QUOTED_OR_WHITESPACE =
  /('(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\])|\s+/g;

function normalizeSql(sql: string | null): string {
  return (sql ?? "")
    .replace(QUOTED_OR_WHITESPACE, (match, quoted: string | undefined) =>
      quoted === undefined ? " " : match,
    )
    .trim();
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
  const rows = (
    sqlite
      .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY rowid")
      .safeIntegers(true)
      .all() as Array<{ name: string; seq: bigint }>
  ).map((row): [string, string] => [row.name, row.seq.toString()]);
  const seen = new Set<string>();
  for (const [name] of rows) {
    if (seen.has(name))
      throw new Error(`Duplicate sqlite_sequence rows for ${name}`);
    seen.add(name);
  }
  return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function describePragmas(
  sqlite: Database.Database,
): Record<string, string> {
  const scalar = (pragma: string): string =>
    String(sqlite.pragma(pragma, { simple: true }));
  return {
    application_id: scalar("application_id"),
    auto_vacuum: scalar("auto_vacuum"),
    foreign_key_violations: String(
      (sqlite.pragma("foreign_key_check") as unknown[]).length,
    ),
    integrity_check: (
      sqlite.pragma("integrity_check") as Array<{ integrity_check: string }>
    )
      .map((row) => row.integrity_check)
      .join(";"),
    user_version: scalar("user_version"),
  };
}

export function describeLedger(sqlite: Database.Database): TableDigest {
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
    .get();
  if (!exists) return { count: 0, digest: "0".repeat(32) };
  return digestTable(sqlite, "__drizzle_migrations");
}

export function describeLedgerSchema(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = '__drizzle_migrations' ORDER BY type, name",
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
    pragmas: describePragmas(sqlite),
    sequences: describeSequences(sqlite),
    tables,
    ledger: describeLedger(sqlite),
    ledgerSchema: describeLedgerSchema(sqlite),
  };
}

export function contentOnly(
  description: DatabaseDescription,
): Omit<DatabaseDescription, "ledger" | "ledgerSchema"> {
  return {
    schema: description.schema,
    pragmas: description.pragmas,
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
  expected: Omit<DatabaseDescription, "ledger" | "ledgerSchema">,
  actual: Omit<DatabaseDescription, "ledger" | "ledgerSchema">,
): string[] {
  const differences: string[] = [];
  const expectedSchema = new Set(expected.schema);
  const actualSchema = new Set(actual.schema);
  for (const line of expectedSchema)
    if (!actualSchema.has(line)) differences.push(`schema missing: ${line}`);
  for (const line of actualSchema)
    if (!expectedSchema.has(line)) differences.push(`schema extra: ${line}`);
  if (JSON.stringify(expected.pragmas) !== JSON.stringify(actual.pragmas))
    differences.push(
      `pragmas differ: ${JSON.stringify(expected.pragmas)} vs ${JSON.stringify(actual.pragmas)}`,
    );
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
